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
    flow_id: null,
    client_origin: clientOrigin,
    client_host: clientUrl?.host || null,
    client_scheme: clientUrl?.protocol.replace(':', '') || null,
    upstream_origin: upstreamOrigin,
    upstream_host: upstreamUrl?.host || null,
    upstream_scheme: upstreamUrl?.protocol.replace(':', '') || null,
    upstream_status: null,
    client_status: null,
    redirect_chain: [],
    cookie_processing_summary: { received: 0, stored: 0, rejected: 0, forwarded: false, anubisCookies: [] },
    anubis_mappings: [],
    response_processing_stage: 'client-received',
    error_category: null,
    error_stage: null,
    error_message: null,
    client_aborted: false,
    error_events: [],
    protocol_flow: /\/(?:\.within\.website|cdn-cgi\/challenge-platform)(?:\/|$)/.test(req.url || '') ? 'anubis-or-edge-challenge' : 'ordinary',
    anubis_version: null,
    anubis_version_supported: false,
  };
}

const SENSITIVE_VALUE = /\b(cookie|set-cookie|authorization|proxy-authorization|token|jwt|password|passwd|secret|session(?:_id)?|sid|challenge|assertion|response|nonce)\b\s*[:=]\s*([^\s;,]+)/gi;

export function sanitizeErrorMessage(message, maxLength = 240) {
  return String(message || 'Proxy operation failed')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\b(authorization|proxy-authorization)\b\s*[:=]\s*(?:(?:bearer|basic)\s+)?[^\s;,]+/gi, '$1=[redacted]')
    .replace(SENSITIVE_VALUE, '$1=[redacted]')
    .replace(/https?:\/\/[^\s]+/gi, '[url]')
    .slice(0, maxLength);
}

export function transitionResponseStage(context, stage) {
  if (!context || !stage) return;
  if (context.error_category || context.client_aborted) return;
  context.response_processing_stage = stage;
}

export function recordError(context, { category, stage, message, code = null, clientAborted = false, details = null } = {}) {
  if (!context || !category) return;
  const safeMessage = sanitizeErrorMessage(message || code || category);
  const event = { category, stage: stage || 'unknown', message: safeMessage };
  if (typeof code === 'string' && /^[A-Z0-9_-]{1,64}$/i.test(code)) event.code = code;
  if (details && typeof details === 'object') {
    const safeDetails = {};
    if (Number.isInteger(details.closeCode) && details.closeCode >= 0 && details.closeCode <= 4999) safeDetails.closeCode = details.closeCode;
    if (typeof details.closeReason === 'string') safeDetails.closeReason = sanitizeErrorMessage(details.closeReason, 120);
    if (Object.keys(safeDetails).length) event.details = safeDetails;
  }
  context.error_events ||= [];
  context.error_events.push(event);
  context.client_aborted = Boolean(context.client_aborted || clientAborted);
  if (!context.error_category) {
    context.error_category = category;
    context.error_stage = stage || 'unknown';
    context.error_message = safeMessage;
  }
  context.response_processing_stage = 'error';
}

export function recordRedirect(context, location, direction = 'upstream-to-client') {
  if (!context || !location) return;
  let safeLocation = String(location);
  const relative = !/^[a-z][a-z\d+.-]*:/i.test(safeLocation) && !safeLocation.startsWith('//');
  try {
    const url = new URL(safeLocation, context.upstream_origin || context.client_origin || 'http://invalid.local');
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:authorization|cookie|set-cookie|token|jwt|session|sid|password|passwd|secret|code|challenge|assertion|response|nonce|redir|id|elapsedtime|proof|pow)$/i.test(key)) url.searchParams.set(key, '[redacted]');
    }
    safeLocation = relative ? `${url.pathname}${url.search}${url.hash}` : url.href;
  } catch { safeLocation = '[invalid-location]'; }
  context.redirect_chain.push({ direction, location: safeLocation });
}
