const SENSITIVE_QUERY_KEYS = /^(?:authorization|cookie|set-cookie|token|jwt|session|sid|password|passwd|secret|code|challenge|assertion)$/i;

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
      emit({ type: 'request', requestId: event.requestId, method: event.method, route: event.route, upstreamHost: event.upstreamHost, path: sanitizePath(event.path || '/') });
    },
    response(event) {
      emit({ type: 'client-response', requestId: event.requestId, status: event.clientStatus, elapsedMs: event.elapsedMs });
    },
    upstreamResponse(event) {
      emit({ type: 'upstream-response', requestId: event.requestId, status: event.upstreamStatus, elapsedMs: event.elapsedMs });
    },
    error(event) {
      emit({ type: 'error', requestId: event.requestId, category: event.category, code: event.code, status: event.statusCode });
    },
  };
}
