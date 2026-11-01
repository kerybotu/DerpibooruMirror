const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL']);
const CONNECT_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET']);

export function classifyProxyError(error, { clientAborted = false, timedOut = false } = {}) {
  if (clientAborted || error?.code === 'ECONNABORTED') {
    return { category: 'client-aborted', statusCode: null, code: error?.code || 'CLIENT_ABORTED' };
  }
  if (timedOut) {
    return { category: 'upstream-timeout', statusCode: 504, code: error?.code || 'PROXY_TIMEOUT' };
  }
  if (error?.code === 'ETIMEDOUT' || error?.code === 'ESOCKETTIMEDOUT') {
    return { category: 'upstream-timeout', statusCode: 504, code: error.code };
  }
  if (DNS_CODES.has(error?.code)) {
    return { category: 'dns-failure', statusCode: 502, code: error.code };
  }
  if (CONNECT_CODES.has(error?.code)) {
    return { category: 'upstream-connect-failure', statusCode: 502, code: error.code };
  }
  if (error?.code === 'CERT_HAS_EXPIRED' || error?.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || error?.code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
    return { category: 'tls-handshake-failure', statusCode: 502, code: error.code };
  }
  return { category: 'upstream-connection-failure', statusCode: 502, code: error?.code || 'UPSTREAM_ERROR' };
}

export function errorResponse(res, classification, requestId) {
  if (!res || res.headersSent || res.writableEnded || res.destroyed) return;
  const statusCode = classification.statusCode || 499;
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-request-id': requestId,
  });
  res.end(JSON.stringify({ error: classification.category, requestId }));
}
