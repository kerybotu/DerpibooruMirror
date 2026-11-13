import { EventEmitter } from 'node:events';
import { ProxyEngine } from './proxy-engine.mjs';
import { createRequestContext, recordError, transitionResponseStage } from './request-context.mjs';
import { sanitizePath } from './diagnostics.mjs';

export class UpstreamGateway {
  #engine;
  constructor({ engine = null, engineOptions = {} } = {}) { this.#engine = engine || new ProxyEngine(engineOptions); }
  get engine() { return this.#engine; }
  async dispatch(req, res, { route, routeName, context } = {}) {
    if (!context) throw new TypeError('request context is required');
    context.response_processing_stage = 'upstream-request';
    context.upstream_origin = new URL(route.target).origin;
    context.upstream_host = new URL(route.target).host;
    return this.#engine.handle(req, res, { route, routeName, requestContext: context });
  }
  upgrade(req, socket, head, { route, routeName, context } = {}) {
    context.response_processing_stage = 'upstream-request';
    context.upstream_origin = new URL(route.target).origin;
    context.upstream_host = new URL(route.target).host;
    return this.#engine.handleUpgrade(req, socket, head, { route, routeName, requestContext: context });
  }
}

export class ClientGateway extends EventEmitter {
  #upstream; #publicOrigin; #route; #routeName;
  constructor({ upstreamGateway, publicOrigin, route, routeName = route?.name } = {}) {
    super();
    if (!upstreamGateway || !publicOrigin || !route?.target) throw new TypeError('upstreamGateway, publicOrigin and fixed route are required');
    this.#upstream = upstreamGateway; this.#publicOrigin = new URL(publicOrigin).origin; this.#route = route; this.#routeName = routeName;
  }
  async handle(req, res) {
    const context = createRequestContext(req, { publicOrigin: this.#publicOrigin, upstreamOrigin: new URL(this.#route.target).origin });
    res.once('finish', () => {
      context.client_status = res.statusCode;
      transitionResponseStage(context, 'client-response-complete');
    });
    res.once('close', () => {
      context.client_status = res.statusCode || null;
      if (!res.writableEnded && !context.error_category) {
        recordError(context, {
          category: 'client-aborted',
          stage: 'client-response',
          message: 'Client closed the response before completion',
          code: 'CLIENT_ABORTED',
          clientAborted: true,
        });
      }
    });
    context.startedAt = Date.now();
    res.once('finish', () => this.emit('client-response', { requestId: context.request_id, flowId: context.flow_id, clientStatus: res.statusCode, elapsedMs: Date.now() - context.startedAt }));
    const result = await this.#upstream.dispatch(req, res, { route: this.#route, routeName: this.#routeName, context });
    this.emit('client-request', { requestId: context.request_id, flowId: context.flow_id, anubisVersion: context.anubis_version, method: req.method, clientOrigin: context.client_origin, route: this.#routeName, path: sanitizePath(req.url) });
    return { ...result, context };
  }
  upgrade(req, socket, head) {
    const context = createRequestContext(req, { publicOrigin: this.#publicOrigin, upstreamOrigin: new URL(this.#route.target).origin });
    return { ...this.#upstream.upgrade(req, socket, head, { route: this.#route, routeName: this.#routeName, context }), context };
  }
}
