import httpProxy from 'http-proxy';
import { EventEmitter } from 'node:events';
import { createRequestId } from './request-id.mjs';
import { classifyProxyError, errorResponse } from './errors.mjs';

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

export class ProxyEngine extends EventEmitter {
  #proxy;
  #sessions;
  #rewriter;
  #requestContexts = new WeakMap();
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
    this.#proxy.on('error', (error, req, res) => {
      const context = this.#requestContexts.get(req) || { requestId: createRequestId() };
      this.#handleError(error, req, res, context);
    });
  }

  async handle(req, res, { route, routeName = route?.name } = {}) {
    if (!route?.target) throw new TypeError('a validated route is required');
    const requestId = createRequestId();
    const { session, isNew } = this.#sessions.getOrCreate(req.headers.cookie);
    const upstreamUrl = new URL(req.url, route.target).href;
    const passthrough = matchesPath(req.url, route.passthroughPaths || []);
    const preserve = passthrough || matchesPath(req.url, route.preservePaths || []);
    const cookie = passthrough
      ? this.#sessions.browserCookiesForPassthrough(req.headers.cookie)
      : await this.#sessions.getUpstreamCookie(session, upstreamUrl);
    const context = { requestId, route, routeName, session, isNew, passthrough, preserve, upstreamUrl, startedAt: Date.now(), clientAborted: false, clientAbortReported: false, timedOut: false };
    this.#requestContexts.set(req, context);
    req.once('aborted', () => {
      context.clientAborted = true;
      if (!context.clientAbortReported) {
        context.clientAbortReported = true;
        this.emit('error-classified', { requestId, category: 'client-aborted', statusCode: null, code: 'CLIENT_ABORTED' });
      }
    });
    res.once('close', () => {
      if (!res.writableEnded) {
        context.clientAborted = true;
        if (!context.clientAbortReported) {
          context.clientAbortReported = true;
          this.emit('error-classified', { requestId, category: 'client-aborted', statusCode: null, code: 'CLIENT_ABORTED' });
        }
      }
    });
    this.emit('request', { requestId, method: req.method, route: routeName, path: req.url, upstreamHost: new URL(route.target).host });
    const timeoutTimer = setTimeout(() => { context.timedOut = true; }, Math.max(1, this.#proxyOptions.proxyTimeout - 10));
    try {
      this.#proxy.web(req, res, {
        ...this.#proxyOptions,
        target: route.target,
        headers: { cookie },
      });
    } catch (error) {
      this.#handleError(error, req, res, context);
    } finally {
      context.timeoutTimer = timeoutTimer;
    }
    return { requestId, session, isNew };
  }

  handleUpgrade(req, socket, head, { route, routeName = route?.name } = {}) {
    if (!route?.target) throw new TypeError('a validated route is required');
    const requestId = createRequestId();
    const { session } = this.#sessions.getOrCreate(req.headers.cookie);
    const passthrough = matchesPath(req.url, route.passthroughPaths || []);
    const upstreamUrl = new URL(req.url, route.target).href;
    const cookiePromise = passthrough
      ? Promise.resolve(this.#sessions.browserCookiesForPassthrough(req.headers.cookie))
      : this.#sessions.getUpstreamCookie(session, upstreamUrl);
    cookiePromise.then((cookie) => {
      this.#proxy.ws(req, socket, head, { ...this.#proxyOptions, target: route.target, headers: { cookie } });
    }).catch(() => socket.destroy());
    this.emit('upgrade', { requestId, method: req.method, route: routeName, upstreamHost: new URL(route.target).host });
    return { requestId };
  }

  getContext(req) {
    return this.#requestContexts.get(req) || null;
  }

  async #handleProxyResponse(proxyRes, req, res, context) {
    const headers = { ...proxyRes.headers };
    context.upstreamResponse = { statusCode: proxyRes.statusCode, headers: { ...headers } };
    this.emit('response', { requestId: context.requestId, statusCode: proxyRes.statusCode, upstreamStatus: proxyRes.statusCode, elapsedMs: Date.now() - context.startedAt });
    this.emit('upstream-response', {
      requestId: context.requestId,
      statusCode: proxyRes.statusCode,
      upstreamStatus: proxyRes.statusCode,
      headerNames: Object.keys(headers),
    });

    if (!context.passthrough) {
      await this.#sessions.receiveSetCookies(context.session, context.upstreamUrl, headers['set-cookie']);
      delete headers['set-cookie'];
    }
    if (context.isNew && !context.passthrough) headers['set-cookie'] = [...(headers['set-cookie'] || []), this.#sessions.browserCookie(context.session)];

    if (headers.location && this.#rewriter && !context.preserve) {
      headers.location = this.#rewriter.rewriteLocation(headers.location, context.upstreamUrl);
    }

    const shouldRewrite = this.#rewriter && !context.preserve && REWRITE_TYPES.has(contentType(headers['content-type'])) && !headers['content-encoding'] && req.method !== 'HEAD';
    if (!shouldRewrite) {
      this.#sendHeaders(res, proxyRes.statusCode, headers, context.requestId);
      proxyRes.pipe(res);
      proxyRes.once('error', (error) => this.#handleError(error, req, res, context));
      return;
    }

    const body = await this.#readUpTo(proxyRes, this.#maxRewriteBytes);
    if (!body.complete) {
      this.#sendHeaders(res, proxyRes.statusCode, headers, context.requestId);
      res.write(body.buffer);
      proxyRes.pipe(res);
      proxyRes.once('error', (error) => this.#handleError(error, req, res, context));
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
    const classification = classifyProxyError(error, { clientAborted: context.clientAborted || req?.aborted || res?.destroyed, timedOut: context.timedOut });
    this.emit('error-classified', { requestId: context.requestId, ...classification });
    if (classification.category === 'client-aborted') return;
    errorResponse(res, classification, context.requestId);
  }
}
