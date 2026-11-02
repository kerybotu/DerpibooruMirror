import { createRequestId } from './request-id.mjs';

function originFromRequest(req, fallback = null) {
  if (fallback) return new URL(fallback).origin;
  const host = req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return host ? `${proto}://${host}` : null;
}

export function createRequestContext(req, { publicOrigin = null, upstreamOrigin = null, requestId = createRequestId() } = {}) {
  const clientOrigin = originFromRequest(req, publicOrigin);
  const clientUrl = clientOrigin ? new URL(req.url || '/', clientOrigin) : null;
  const upstreamUrl = upstreamOrigin ? new URL(req.url || '/', upstreamOrigin) : null;
  return {
    request_id: requestId,
    client_origin: clientOrigin,
    client_host: clientUrl?.host || null,
    client_scheme: clientUrl?.protocol.replace(':', '') || null,
    upstream_origin: upstreamOrigin,
    upstream_host: upstreamUrl?.host || null,
    upstream_scheme: upstreamUrl?.protocol.replace(':', '') || null,
    upstream_status: null,
    client_status: null,
    redirect_chain: [],
    cookie_processing_summary: { received: 0, stored: 0, rejected: 0, forwarded: false },
    response_processing_stage: 'client-received',
    protocol_flow: /\/(?:\.within\.website|cdn-cgi\/challenge-platform)(?:\/|$)/.test(req.url || '') ? 'anubis-or-edge-challenge' : 'ordinary',
  };
}

export function recordRedirect(context, location, direction = 'upstream-to-client') {
  if (!context || !location) return;
  let safeLocation = String(location);
  const relative = !/^[a-z][a-z\d+.-]*:/i.test(safeLocation) && !safeLocation.startsWith('//');
  try {
    const url = new URL(safeLocation, context.upstream_origin || context.client_origin || 'http://invalid.local');
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:authorization|cookie|set-cookie|token|jwt|session|sid|password|passwd|secret|code|challenge|assertion|response|nonce)$/i.test(key)) url.searchParams.set(key, '[redacted]');
    }
    safeLocation = relative ? `${url.pathname}${url.search}${url.hash}` : url.href;
  } catch { safeLocation = '[invalid-location]'; }
  context.redirect_chain.push({ direction, location: safeLocation });
}
