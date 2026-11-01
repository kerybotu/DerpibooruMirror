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
      this.#routes.set(name, Object.freeze({
        name,
        target: target.origin,
        publicOrigin,
        rewrite: route.rewrite || null,
        preservePaths: Array.isArray(route.preservePaths) ? [...route.preservePaths] : [],
        passthroughPaths: Array.isArray(route.passthroughPaths) ? [...route.passthroughPaths] : [],
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
