function normalizeOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`Origin must be an HTTP(S) origin: ${value}`);
  }
  return url.origin;
}

export class RoutePolicy {
  #routes;

  constructor(routes) {
    if (!routes || typeof routes !== 'object') throw new TypeError('routes are required');
    this.#routes = new Map();
    for (const [name, route] of Object.entries(routes)) {
      if (!route?.target || !route?.publicOrigin) throw new Error(`Route ${name} requires target and publicOrigin`);
      const target = new URL(route.target);
      if (!['http:', 'https:'].includes(target.protocol)) throw new Error(`Unsupported target protocol for ${name}`);
      const publicOrigin = normalizeOrigin(route.publicOrigin);
      const upstreamHost = route.upstreamHost == null ? null : String(route.upstreamHost);
      if (upstreamHost && (!/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(upstreamHost) || upstreamHost.includes('..'))) {
        throw new Error(`Route ${name} upstreamHost is invalid`);
      }
      let anubisBridge = null;
      if (route.anubisBridge?.enabled) {
        const bridge = route.anubisBridge;
        if (typeof bridge.supportedVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(bridge.supportedVersion)) throw new Error(`Route ${name} Anubis bridge requires an exact supportedVersion`);
        const upstreamOrigin = bridge.upstreamOrigin == null ? target.origin : normalizeOrigin(bridge.upstreamOrigin);
        anubisBridge = Object.freeze({
          supportedVersion: bridge.supportedVersion,
          cookiePrefix: bridge.cookiePrefix || 'techaro.lol-anubis',
          basePrefix: bridge.basePrefix || '',
          upstreamOrigin,
        });
      }
      this.#routes.set(name, Object.freeze({
        name,
        target: target.origin,
        upstreamHost,
        publicOrigin,
        rewrite: route.rewrite || null,
        preservePaths: Array.isArray(route.preservePaths) ? [...route.preservePaths] : [],
        passthroughPaths: Array.isArray(route.passthroughPaths) ? [...route.passthroughPaths] : [],
        anubisBridge,
      }));
    }
  }

  get(name) {
    const route = this.#routes.get(name);
    if (!route) throw new Error(`Unknown route: ${name}`);
    return route;
  }

  has(name) {
    return this.#routes.has(name);
  }

  list() {
    return [...this.#routes.values()].map(({ name, target, publicOrigin }) => ({ name, target, publicOrigin }));
  }
}

export function isAllowedUpstream(url, allowedOrigins) {
  const parsed = new URL(url);
  return allowedOrigins.some((origin) => parsed.origin === origin);
}
