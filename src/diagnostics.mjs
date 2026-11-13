const SENSITIVE_QUERY_KEYS = /^(?:authorization|cookie|set-cookie|token|jwt|session|sid|password|passwd|secret|code|challenge|assertion|response|nonce|redir|id|elapsedtime|proof|pow)$/i;

export function sanitizePath(input) {
  try {
    const url = new URL(input, 'http://invalid.local');
    const params = [];
    for (const [key, value] of url.searchParams) params.push(`${encodeURIComponent(key)}=${SENSITIVE_QUERY_KEYS.test(key) ? '[redacted]' : encodeURIComponent(value)}`);
    return `${url.pathname || '/'}${params.length ? `?${params.join('&')}` : ''}`;
  } catch {
    return '/[invalid-path]';
  }
}

export function createDiagnosticLogger(write = (line) => process.stderr.write(`${line}\n`)) {
  const emit = (event) => write(JSON.stringify(event));
  return {
    request(event) {
      emit({ type: 'request', requestId: event.requestId, flowId: event.flowId || null, anubisVersion: event.anubisVersion || null, method: event.method, route: event.route, upstreamHost: event.upstreamHost, path: sanitizePath(event.path || '/') });
    },
    response(event) {
      emit({ type: 'client-response', requestId: event.requestId, flowId: event.flowId || null, status: event.clientStatus, elapsedMs: event.elapsedMs });
    },
    upstreamResponse(event) {
      emit({ type: 'upstream-response', requestId: event.requestId, flowId: event.flowId || null, anubisVersion: event.anubisVersion || null, status: event.upstreamStatus, contentType: event.contentType || null, elapsedMs: event.elapsedMs });
    },
    anubisChallenge(event) {
      emit({ type: 'anubis-challenge', requestId: event.requestId, flowId: event.flowId, version: event.version, supported: event.supported, status: event.statusCode, contentType: event.contentType });
    },
    anubisMapping(event) {
      emit({ type: 'anubis-mapping', requestId: event.requestId, flowId: event.flowId, direction: event.direction, fromOrigin: event.from_origin, toOrigin: event.to_origin });
    },
    anubisCookieSummary(event) {
      emit({ type: 'anubis-cookie-summary', requestId: event.requestId, flowId: event.flowId, cookies: event.cookies });
    },
    error(event) {
      emit({ type: 'error', requestId: event.requestId, flowId: event.flowId || null, category: event.category, code: event.code, status: event.statusCode });
    },
  };
}
