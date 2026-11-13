import httpProxy from 'http-proxy';
import { EventEmitter } from 'node:events';
import { createRequestId } from './request-id.mjs';
import { classifyProxyError, errorResponse } from './errors.mjs';
import { recordError, recordRedirect, transitionResponseStage } from './request-context.mjs';
import { createAnubisBridge } from './anubis-bridge/index.mjs';
import { sanitizePath } from './diagnostics.mjs';

const REWRITE_TYPES = new Set([
  'text/html',
  'text/css',
  'application/json',
  'application/javascript',
  'text/javascript',
]);

function contentType(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

function copyHeaders(headers) {
  const copied = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'].includes(key.toLowerCase())) continue;
    copied[key] = value;
  }
  return copied;
}

function matchesPath(reqUrl, paths) {
  return paths.some((prefix) => typeof prefix === 'string' && reqUrl.startsWith(prefix));
}

function observeWebSocketCloseFrame(socket, onClose) {
  let pending = Buffer.alloc(0);
  let remainingPayload = 0n;
  const onData = (chunk) => {
    if (remainingPayload > 0n) {
      if (BigInt(chunk.length) <= remainingPayload) {
        remainingPayload -= BigInt(chunk.length);
        return;
      }
      chunk = chunk.subarray(Number(remainingPayload));
      remainingPayload = 0n;
    }
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= 2) {
      const opcode = pending[0] & 0x0f;
      const masked = Boolean(pending[1] & 0x80);
      let payloadLength = BigInt(pending[1] & 0x7f);
      let headerLength = 2;
      if (payloadLength === 126n) {
        if (pending.length < 4) return;
        payloadLength = BigInt(pending.readUInt16BE(2)); headerLength = 4;
      } else if (payloadLength === 127n) {
        if (pending.length < 10) return;
        payloadLength = pending.readBigUInt64BE(2); headerLength = 10;
      }
      if (masked) headerLength += 4;
      if (payloadLength > BigInt(Number.MAX_SAFE_INTEGER)) { socket.off('data', onData); return; }
      const length = Number(payloadLength);
      if (opcode === 0x8 && length <= 125) {
        if (pending.length < headerLength + length) return;
        let payload = Buffer.from(pending.subarray(headerLength, headerLength + length));
        if (masked) {
          const maskOffset = headerLength - 4;
          for (let i = 0; i < payload.length; i++) payload[i] ^= pending[maskOffset + (i % 4)];
        }
        const closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : null;
        const closeReason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        socket.off('data', onData);
        onClose({ closeCode, closeReason });
        return;
      }
      const frameLength = headerLength + length;
      if (pending.length < frameLength) {
        remainingPayload = BigInt(frameLength - pending.length);
        pending = Buffer.alloc(0);
        return;
      }
      pending = pending.subarray(frameLength);
    }
  };
  socket.on('data', onData);
}

export class ProxyEngine extends EventEmitter {
  #proxy;
  #sessions;
  #rewriter;
  #requestContexts = new WeakMap();
  #bridges = new WeakMap();
  #maxRewriteBytes;
  #proxyOptions;

  constructor({ sessionManager, urlRewriter = null, maxRewriteBytes = 2 * 1024 * 1024, proxyTimeoutMs = 15_000, timeoutMs = 15_000, upstreamTls = {} } = {}) {
    super();
    if (!sessionManager) throw new TypeError('sessionManager is required');
    this.#sessions = sessionManager;
    this.#rewriter = urlRewriter;
    this.#maxRewriteBytes = maxRewriteBytes;
    if (upstreamTls.secure === false) throw new Error('upstream TLS verification cannot be disabled');
    const { ca, cert, key, pfx, passphrase } = upstreamTls;
    this.#proxyOptions = { proxyTimeout: proxyTimeoutMs, timeout: timeoutMs, secure: true, ca, cert, key, pfx, passphrase };
    this.#proxy = httpProxy.createProxyServer({
      changeOrigin: true,
      secure: true,
      selfHandleResponse: true,
      xfwd: false,
    });
    this.#proxy.on('proxyRes', (proxyRes, req, res) => {
      const context = this.#requestContexts.get(req);
      if (!context) return;
      if (context.timeoutTimer) clearTimeout(context.timeoutTimer);
      this.#handleProxyResponse(proxyRes, req, res, context).catch((error) => this.#handleError(error, req, res, context));
    });
    this.#proxy.on('proxyReq', (proxyReq, req) => {
      const context = this.#requestContexts.get(req);
      if (context?.route.upstreamHost) proxyReq.setHeader('host', context.route.upstreamHost);
    });
    this.#proxy.on('error', (error, req, res) => {
      const context = this.#requestContexts.get(req) || { requestId: createRequestId() };
      this.#handleError(error, req, res, context);
    });
    this.#proxy.on('proxyReqWs', (proxyReq, req) => {
      const context = this.#requestContexts.get(req);
      if (!context?.websocket) return;
      if (context.route.upstreamHost) proxyReq.setHeader('host', context.route.upstreamHost);
      proxyReq.once('upgrade', (_proxyRes, proxySocket) => {
        context.opened = true;
        observeWebSocketCloseFrame(proxySocket, ({ closeCode, closeReason }) => {
          if (closeCode === 1000 || closeCode === 1001) {
            transitionResponseStage(context.requestContext, 'websocket-lifecycle-ended');
            return;
          }
          recordError(context.requestContext, {
            category: 'websocket-abnormal-close',
            stage: 'websocket-lifecycle',
            message: 'WebSocket upstream sent an abnormal close frame',
            code: 'WS_ABNORMAL_CLOSE',
            details: { closeCode, closeReason },
          });
          this.emit('error-classified', { requestId: context.requestId, category: 'websocket-abnormal-close', statusCode: null, code: 'WS_ABNORMAL_CLOSE' });
        });
        proxySocket.once('error', (error) => {
          const code = typeof error?.code === 'string' ? error.code : 'WS_TRANSPORT_ERROR';
          recordError(context.requestContext, {
            category: 'websocket-transport-failure',
            stage: 'websocket-lifecycle',
            message: error?.message || 'WebSocket upstream transport failed',
            code,
            details: { closeCode: error?.closeCode, closeReason: error?.reason },
          });
          this.emit('error-classified', { requestId: context.requestId, category: 'websocket-transport-failure', statusCode: null, code });
        });
        proxySocket.once('close', (hadError) => {
          if (hadError && !context.requestContext?.error_category) {
            recordError(context.requestContext, {
              category: 'websocket-transport-failure',
              stage: 'websocket-lifecycle',
              message: 'WebSocket upstream transport closed abnormally',
              code: 'WS_ABNORMAL_CLOSE',
            });
            this.emit('error-classified', { requestId: context.requestId, category: 'websocket-transport-failure', statusCode: null, code: 'WS_ABNORMAL_CLOSE' });
          } else if (!context.requestContext?.error_category) {
            transitionResponseStage(context.requestContext, 'websocket-lifecycle-ended');
          }
        });
      });
      proxyReq.once('response', (proxyRes) => {
        if (proxyRes.statusCode === 101) return;
        recordError(context.requestContext, {
          category: 'websocket-upstream-rejected',
          stage: 'websocket-handshake',
          message: `Upstream rejected WebSocket handshake with HTTP ${proxyRes.statusCode}`,
          code: 'WS_HANDSHAKE_REJECTED',
        });
      });
    });
  }

  #bridgeFor(route, requestContext) {
    const config = route?.anubisBridge;
    if (!config || config.enabled === false) return null;
    if (!this.#bridges.has(route)) {
      this.#bridges.set(route, createAnubisBridge({
        clientOrigin: route.publicOrigin || requestContext?.client_origin,
        upstreamOrigin: config.upstreamOrigin || route.target,
        supportedVersion: config.supportedVersion,
        cookiePrefix: config.cookiePrefix,
        basePrefix: config.basePrefix,
      }));
    }
    return this.#bridges.get(route);
  }

  #rejectAnubisBridge(res, requestContext, requestId, error, stage = 'anubis-adaptation') {
    const classification = { category: 'anubis-bridge-rejected', statusCode: 502, code: 'ANUBIS_BRIDGE_REJECTED' };
    recordError(requestContext, { ...classification, stage, message: error?.message || 'Anubis compatibility adaptation rejected' });
    this.emit('error-classified', { requestId, flowId: requestContext?.flow_id || null, ...classification });
    errorResponse(res, classification, requestId);
  }

  async handle(req, res, { route, routeName = route?.name, requestContext = null } = {}) {
    if (!route?.target) throw new TypeError('a validated route is required');
    const requestId = requestContext?.request_id || createRequestId();
    let bridge;
    let outgoingUrl = req.url;
    try {
      bridge = this.#bridgeFor(route, requestContext);
    } catch (error) {
      this.#rejectAnubisBridge(res, requestContext, requestId, error, 'anubis-request-adaptation');
      return { requestId, session: null, isNew: false };
    }
    const passthrough = matchesPath(req.url, route.passthroughPaths || []);
    let session; let isNew; let cookie;
    try {
      ({ session, isNew } = this.#sessions.getOrCreate(req.headers.cookie));
    } catch (error) {
      const classification = { category: 'session-cookie-failure', statusCode: 502, code: 'SESSION_COOKIE_FAILURE' };
      recordError(requestContext, { ...classification, stage: 'cookie-session', message: error?.message || classification.category });
      this.emit('error-classified', { requestId, ...classification });
      errorResponse(res, classification, requestId);
      return { requestId, session: null, isNew: false };
    }
    if (bridge) {
      try { outgoingUrl = bridge.mapClientRequest(req.url, session, req.method); }
      catch (error) {
        this.#rejectAnubisBridge(res, requestContext, requestId, error, 'anubis-request-adaptation');
        return { requestId, session, isNew };
      }
    }
    if (requestContext) {
      requestContext.flow_id = session.flowId;
      requestContext.anubis_version = session.anubisVersion || null;
      requestContext.anubis_version_supported = Boolean(bridge && session.anubisVersion === route.anubisBridge?.supportedVersion);
      if (outgoingUrl !== req.url) {
        const mapping = { direction: 'client-to-upstream', from_origin: requestContext.client_origin, to_origin: requestContext.upstream_origin };
        requestContext.anubis_mappings.push(mapping);
        this.emit('anubis-mapping', { requestId, flowId: session.flowId, ...mapping });
      }
    }
    try {
      cookie = bridge
        ? await this.#sessions.getUpstreamCookieWithBrowserCookies(session, new URL(outgoingUrl, route.target).href, req.headers.cookie)
        : passthrough
          ? this.#sessions.browserCookiesForPassthrough(req.headers.cookie)
          : await this.#sessions.getUpstreamCookie(session, new URL(outgoingUrl, route.target).href);
    } catch (error) {
      const classification = { category: 'session-cookie-failure', statusCode: 502, code: 'SESSION_COOKIE_FAILURE' };
      recordError(requestContext, { ...classification, stage: 'cookie-session', message: error?.message || classification.category });
      this.emit('error-classified', { requestId, ...classification });
      errorResponse(res, classification, requestId);
      return { requestId, session: null, isNew: false };
    }
    const upstreamUrl = new URL(outgoingUrl, route.target).href;
    const preserve = passthrough || matchesPath(req.url, route.preservePaths || []);
    const context = { requestId, route, routeName, session, isNew, passthrough, preserve, bridge, passChallenge: Boolean(bridge?.isPassChallengeRequest(req.url)), clientUrl: req.url, upstreamUrl, startedAt: Date.now(), clientAborted: false, clientAbortReported: false, timedOut: false, requestContext };
    transitionResponseStage(requestContext, 'upstream-request');
    this.#requestContexts.set(req, context);
    req.once('aborted', () => {
      context.clientAborted = true;
      if (!context.clientAbortReported) {
        context.clientAbortReported = true;
        recordError(requestContext, { category: 'client-aborted', stage: 'client-request', message: 'Client aborted the request', code: 'CLIENT_ABORTED', clientAborted: true });
        this.emit('error-classified', { requestId, category: 'client-aborted', statusCode: null, code: 'CLIENT_ABORTED' });
      }
    });
    res.once('close', () => {
      if (res.writableEnded || context.requestContext?.error_category) return;
      context.clientAborted = true;
      if (!context.clientAbortReported) {
        context.clientAbortReported = true;
        recordError(context.requestContext, { category: 'client-aborted', stage: 'client-response', message: 'Client closed the response before completion', code: 'CLIENT_ABORTED', clientAborted: true });
        this.emit('error-classified', { requestId, category: 'client-aborted', statusCode: null, code: 'CLIENT_ABORTED' });
      }
    });
    this.emit('request', { requestId, flowId: requestContext?.flow_id || null, anubisVersion: requestContext?.anubis_version || null, method: req.method, route: routeName, path: sanitizePath(req.url), upstreamHost: new URL(route.target).host });
    const timeoutTimer = setTimeout(() => { context.timedOut = true; }, Math.max(1, this.#proxyOptions.proxyTimeout - 10));
    try {
      const clientUrl = req.url;
      req.url = outgoingUrl;
      try {
        this.#proxy.web(req, res, {
          ...this.#proxyOptions,
          target: route.target,
          headers: {
            ...(route.upstreamHost ? { host: route.upstreamHost } : {}),
            cookie,
            ...(bridge && /(?:^|,)\s*text\/html\b/i.test(req.headers.accept || '') ? { 'accept-encoding': 'identity' } : {}),
          },
        });
      } finally {
        req.url = clientUrl;
      }
    } catch (error) {
      this.#handleError(error, req, res, context);
    } finally {
      context.timeoutTimer = timeoutTimer;
    }
    return { requestId, session, isNew };
  }

  handleUpgrade(req, socket, head, { route, routeName = route?.name, requestContext = null } = {}) {
    if (!route?.target) throw new TypeError('a validated route is required');
    const requestId = requestContext?.request_id || createRequestId();
    const passthrough = matchesPath(req.url, route.passthroughPaths || []);
    const upstreamUrl = new URL(req.url, route.target).href;
    const wsContext = { requestId, route, routeName, startedAt: Date.now(), requestContext, websocket: true, clientAborted: false };
    this.#requestContexts.set(req, wsContext);
    transitionResponseStage(requestContext, 'websocket-upstream-request');
    socket.once('close', () => {
      if (wsContext.opened && !requestContext?.error_category) transitionResponseStage(requestContext, 'websocket-lifecycle-ended');
    });
    let cookiePromise;
    try {
      const { session } = this.#sessions.getOrCreate(req.headers.cookie);
      cookiePromise = passthrough
        ? Promise.resolve(this.#sessions.browserCookiesForPassthrough(req.headers.cookie))
        : this.#sessions.getUpstreamCookie(session, upstreamUrl);
    } catch (error) {
      cookiePromise = Promise.reject(error);
    }
    cookiePromise.then((cookie) => {
      if (socket.destroyed) return;
      this.#proxy.ws(req, socket, head, { ...this.#proxyOptions, target: route.target, headers: { ...(route.upstreamHost ? { host: route.upstreamHost } : {}), cookie } });
    }).catch((error) => {
      const classification = { category: 'websocket-cookie-failure', statusCode: null, code: 'WEBSOCKET_COOKIE_FAILURE' };
      recordError(requestContext, { ...classification, stage: 'websocket-cookie', message: error?.message || classification.category });
      this.emit('error-classified', { requestId, ...classification });
      socket.destroy();
    });
    socket.once('error', (error) => {
      recordError(requestContext, { category: 'client-aborted', stage: 'websocket-client', message: error?.message || 'WebSocket client disconnected', code: error?.code || 'WS_CLIENT_DISCONNECTED', clientAborted: true });
      this.emit('error-classified', { requestId, category: 'client-aborted', statusCode: null, code: error?.code || 'WS_CLIENT_DISCONNECTED' });
    });
    this.emit('upgrade', { requestId, method: req.method, route: routeName, upstreamHost: new URL(route.target).host });
    return { requestId, context: requestContext };
  }

  getContext(req) {
    return this.#requestContexts.get(req) || null;
  }

  async #handleProxyResponse(proxyRes, req, res, context) {
    const headers = { ...proxyRes.headers };
    context.receivedUpstreamResponse = true;
    context.upstreamResponse = { statusCode: proxyRes.statusCode, headers: { ...headers } };
    if (context.requestContext) {
      context.requestContext.upstream_status = proxyRes.statusCode;
      transitionResponseStage(context.requestContext, 'upstream-response');
      if (headers.location) recordRedirect(context.requestContext, headers.location, 'upstream-response');
    }
    this.emit('response', { requestId: context.requestId, statusCode: proxyRes.statusCode, upstreamStatus: proxyRes.statusCode, elapsedMs: Date.now() - context.startedAt });
    this.emit('upstream-response', {
      requestId: context.requestId,
      flowId: context.requestContext?.flow_id || null,
      anubisVersion: context.requestContext?.anubis_version || null,
      statusCode: proxyRes.statusCode,
      upstreamStatus: proxyRes.statusCode,
      contentType: contentType(headers['content-type']),
      headerNames: Object.keys(headers),
    });

    if (headers.location && context.bridge) {
      try {
        const originalLocation = headers.location;
        headers.location = context.bridge.mapUpstreamLocation(originalLocation, context.clientUrl || req.url, proxyRes.statusCode);
        if (headers.location !== originalLocation && context.requestContext) {
          const mapping = { direction: 'upstream-to-client', from_origin: context.requestContext.upstream_origin, to_origin: context.requestContext.client_origin };
          context.requestContext.anubis_mappings.push(mapping);
          this.emit('anubis-mapping', { requestId: context.requestId, flowId: context.requestContext.flow_id, ...mapping });
        }
      } catch (error) {
        proxyRes.resume();
        this.#rejectAnubisBridge(res, context.requestContext, context.requestId, error, 'anubis-location-adaptation');
        return;
      }
    }

    if (context.bridge && Array.isArray(headers['set-cookie'])) {
      const browserCookies = [];
      const applicationCookies = [];
      try {
        for (const value of headers['set-cookie']) {
          const result = context.bridge.processSetCookie(value, context.session);
          if (result.kind === 'anubis') {
            browserCookies.push(result.cookie);
            context.requestContext?.cookie_processing_summary.anubisCookies.push({ name: result.cookieNames[0], attributes: result.attributeSummary });
          }
          else applicationCookies.push(value);
        }
      } catch (error) {
        proxyRes.resume();
        this.#rejectAnubisBridge(res, context.requestContext, context.requestId, error, 'anubis-cookie-adaptation');
        return;
      }
      const summary = await this.#sessions.receiveSetCookies(context.session, context.upstreamUrl, applicationCookies);
      if (context.requestContext) Object.assign(context.requestContext.cookie_processing_summary, {
        received: headers['set-cookie'].length,
        stored: summary.stored,
        rejected: summary.rejected,
        forwarded: browserCookies.length > 0,
      });
      if (browserCookies.length) this.emit('anubis-cookie-summary', { requestId: context.requestId, flowId: context.requestContext?.flow_id || null, cookies: context.requestContext?.cookie_processing_summary.anubisCookies || [] });
      if (browserCookies.length) headers['set-cookie'] = browserCookies;
      else delete headers['set-cookie'];
    } else if (!context.passthrough) {
      const summary = await this.#sessions.receiveSetCookies(context.session, context.upstreamUrl, headers['set-cookie']);
      if (context.requestContext) Object.assign(context.requestContext.cookie_processing_summary, summary);
      delete headers['set-cookie'];
    } else if (context.requestContext) {
      context.requestContext.cookie_processing_summary.received = Array.isArray(headers['set-cookie']) ? headers['set-cookie'].length : 0;
      context.requestContext.cookie_processing_summary.forwarded = context.requestContext.cookie_processing_summary.received > 0;
    }
    if (context.isNew && !context.passthrough) headers['set-cookie'] = [...(headers['set-cookie'] || []), this.#sessions.browserCookie(context.session)];

    if (headers.location && this.#rewriter && !context.preserve) {
      headers.location = this.#rewriter.rewriteLocation(headers.location, context.upstreamUrl);
    }
    if (headers.location && context.requestContext) recordRedirect(context.requestContext, headers.location, 'client-response');

    const htmlResponse = contentType(headers['content-type']) === 'text/html';
    const inspectChallenge = context.bridge && htmlResponse && !headers['content-encoding'] && req.method !== 'HEAD';
    const shouldRewrite = this.#rewriter && !context.preserve && REWRITE_TYPES.has(contentType(headers['content-type'])) && !headers['content-encoding'] && req.method !== 'HEAD';
    if (!shouldRewrite && !inspectChallenge) {
      this.#sendHeaders(res, proxyRes.statusCode, headers, context.requestId);
      proxyRes.pipe(res);
      proxyRes.once('error', (error) => this.#handleError(error, req, res, context));
      this.#watchUpstreamResponse(proxyRes, req, res, context);
      return;
    }

    const body = await this.#readUpTo(proxyRes, this.#maxRewriteBytes);
    if (!body.complete) {
      this.#sendHeaders(res, proxyRes.statusCode, headers, context.requestId);
      res.write(body.buffer);
      proxyRes.pipe(res);
      proxyRes.once('error', (error) => this.#handleError(error, req, res, context));
      this.#watchUpstreamResponse(proxyRes, req, res, context);
      return;
    }
    if (inspectChallenge) {
      const detection = context.bridge.observeChallengeHtml(context.session, headers['content-type'], body.buffer.toString('utf8'));
      if (detection.recognized) {
        if (context.requestContext) {
          context.requestContext.anubis_version = detection.version;
          context.requestContext.anubis_version_supported = detection.supported;
          context.requestContext.protocol_flow = 'anubis-challenge';
          context.requestContext.flow_id = context.session.flowId;
        }
        this.emit('anubis-challenge', { requestId: context.requestId, flowId: context.session.flowId, version: detection.version, supported: detection.supported, statusCode: proxyRes.statusCode, contentType: contentType(headers['content-type']) });
        this.#sendHeaders(res, proxyRes.statusCode, headers, context.requestId);
        res.end(body.buffer);
        return;
      }
    }
    if (!shouldRewrite) {
      this.#sendHeaders(res, proxyRes.statusCode, headers, context.requestId);
      res.end(body.buffer);
      return;
    }
    const input = body.buffer.toString('utf8');
    const type = contentType(headers['content-type']);
    let rewritten;
    try {
      rewritten = type === 'text/html'
        ? this.#rewriter.rewriteHtml(input, context.upstreamUrl)
        : type === 'text/css'
          ? this.#rewriter.rewriteCss(input, context.upstreamUrl)
          : type === 'application/json'
            ? this.#rewriter.rewriteJson(input, context.upstreamUrl)
            : input;
    } catch (error) {
      recordError(context.requestContext, { category: 'response-parse-failure', stage: 'response-parse', message: error?.message || 'Response rewrite failed', code: error?.code || 'REWRITE_PARSE_ERROR' });
      this.emit('error-classified', { requestId: context.requestId, category: 'response-parse-failure', statusCode: proxyRes.statusCode, code: error.code || 'REWRITE_PARSE_ERROR' });
      this.#sendHeaders(res, proxyRes.statusCode, headers, context.requestId);
      res.end(body.buffer);
      return;
    }
    const output = Buffer.from(rewritten);
    delete headers['content-length'];
    delete headers.etag;
    headers['content-length'] = output.length;
    this.#sendHeaders(res, proxyRes.statusCode, headers, context.requestId);
    res.end(output);
  }

  #readUpTo(stream, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let complete = true;
      const onData = (chunk) => {
        size += chunk.length;
        chunks.push(chunk);
        if (size > limit) {
          complete = false;
          stream.pause();
          cleanup();
          resolve({ complete, buffer: Buffer.concat(chunks) });
        }
      };
      const onEnd = () => { cleanup(); resolve({ complete, buffer: Buffer.concat(chunks) }); };
      const onError = (error) => { cleanup(); reject(error); };
      const cleanup = () => {
        stream.off('data', onData);
        stream.off('end', onEnd);
        stream.off('error', onError);
      };
      stream.on('data', onData);
      stream.once('end', onEnd);
      stream.once('error', onError);
    });
  }

  #sendHeaders(res, statusCode, headers, requestId) {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(statusCode || 502, { ...copyHeaders(headers), 'x-request-id': requestId });
  }

  #handleError(error, req, res, context) {
    if (context.timeoutTimer) clearTimeout(context.timeoutTimer);
    let classification = classifyProxyError(error, { clientAborted: context.clientAborted || req?.aborted, timedOut: context.timedOut });
    if (context.websocket && context.opened) classification = { ...classification, category: 'websocket-transport-failure', statusCode: null };
    if (context.receivedUpstreamResponse && !context.websocket && classification.category !== 'client-aborted') {
      classification = { ...classification, category: 'upstream-response-interrupted', statusCode: 502 };
    }
    const stage = context.websocket
      ? (context.opened ? 'websocket-lifecycle' : 'websocket-connect')
      : context.receivedUpstreamResponse && classification.category === 'upstream-response-interrupted' ? 'upstream-response-stream'
      : classification.category === 'dns-failure' ? 'upstream-dns'
        : classification.category === 'tls-handshake-failure' ? 'upstream-tls'
          : classification.category === 'upstream-timeout' ? 'upstream-timeout'
            : 'upstream-connect';
    recordError(context.requestContext, { ...classification, stage, message: error?.message || classification.category, details: { closeCode: error?.closeCode, closeReason: error?.reason } });
    this.emit('error-classified', { requestId: context.requestId, ...classification });
    if (classification.category === 'client-aborted') return;
    if (context.websocket) {
      if (res && !res.destroyed && typeof res.write === 'function') {
        const statusCode = classification.statusCode || 502;
        const statusText = statusCode === 504 ? 'Gateway Timeout' : 'Bad Gateway';
        res.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nX-Request-ID: ${context.requestId}\r\nContent-Length: 0\r\n\r\n`);
      }
      return;
    }
    errorResponse(res, classification, context.requestId);
  }

  #watchUpstreamResponse(proxyRes, req, res, context) {
    proxyRes.once('aborted', () => {
      const error = Object.assign(new Error('Upstream response stream aborted'), { code: 'UPSTREAM_RESPONSE_ABORTED' });
      recordError(context.requestContext, { category: 'upstream-response-interrupted', stage: 'upstream-response-stream', message: error.message, code: error.code });
      this.emit('error-classified', { requestId: context.requestId, category: 'upstream-response-interrupted', statusCode: 502, code: error.code });
      if (!res.destroyed) res.destroy();
    });
    proxyRes.once('close', () => {
      if (proxyRes.complete || proxyRes.readableEnded) return;
      const error = Object.assign(new Error('Upstream response stream closed before completion'), { code: 'UPSTREAM_RESPONSE_ABORTED' });
      recordError(context.requestContext, { category: 'upstream-response-interrupted', stage: 'upstream-response-stream', message: error.message, code: error.code });
      this.emit('error-classified', { requestId: context.requestId, category: 'upstream-response-interrupted', statusCode: 502, code: error.code });
      if (!res.destroyed) res.destroy();
    });
  }
}
