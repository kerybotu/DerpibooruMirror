import { parse } from 'parse5';

const PASS_CHALLENGE = '/.within.website/x/cmd/anubis/api/pass-challenge';

function textContent(node) {
  if (node.nodeName === '#text') return node.value || '';
  return (node.childNodes || []).map(textContent).join('');
}

function findVersionScript(node) {
  if (node.tagName === 'script' && node.attrs?.some((attr) => attr.name === 'id' && attr.value === 'anubis_version')) return node;
  for (const child of node.childNodes || []) {
    const result = findVersionScript(child);
    if (result) return result;
  }
  return null;
}

function safePath(pathname) {
  if (!pathname.startsWith('/') || pathname.startsWith('//') || pathname.includes('\\') || /[\u0000-\u001f\u007f]/.test(pathname)) return false;
  if (/%(?:2f|5c)/i.test(pathname)) return false;
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return false; }
  if (/%(?:2f|5c|25)/i.test(decoded)) return false;
  return !decoded.startsWith('//') && !decoded.includes('\\') && !decoded.split('/').some((part) => part === '.' || part === '..');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class AnubisCompatibilityBridge {
  #client;
  #upstream;
  #supportedVersion;
  #cookiePrefix;
  #passChallengePath;

  constructor({ clientOrigin, upstreamOrigin, supportedVersion, cookiePrefix = 'techaro.lol-anubis', basePrefix = '' } = {}) {
    this.#client = new URL(clientOrigin);
    this.#upstream = new URL(upstreamOrigin);
    if (!['http:', 'https:'].includes(this.#client.protocol) || this.#client.pathname !== '/' || this.#client.search || this.#client.hash) throw new Error('clientOrigin must be an HTTP(S) origin');
    if (!['http:', 'https:'].includes(this.#upstream.protocol) || this.#upstream.pathname !== '/' || this.#upstream.search || this.#upstream.hash) throw new Error('upstreamOrigin must be an HTTP(S) origin');
    if (this.#client.origin === this.#upstream.origin) throw new Error('clientOrigin and upstreamOrigin must differ');
    if (typeof supportedVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(supportedVersion)) throw new Error('supportedVersion must be an exact semantic version');
    if (typeof cookiePrefix !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(cookiePrefix)) throw new Error('cookiePrefix is invalid');
    if (typeof basePrefix !== 'string' || (basePrefix && (!basePrefix.startsWith('/') || basePrefix.endsWith('/') || basePrefix.includes('?') || basePrefix.includes('#') || basePrefix.includes('..')))) throw new Error('basePrefix is invalid');
    this.#supportedVersion = supportedVersion;
    this.#cookiePrefix = cookiePrefix;
    this.#passChallengePath = `${basePrefix}${PASS_CHALLENGE}`;
  }

  observeChallengeHtml(session, contentType, body) {
    if (!/^text\/html(?:\s*;|$)/i.test(String(contentType || ''))) return { recognized: false, version: null, supported: false };
    let script;
    try { script = findVersionScript(parse(String(body))); } catch { return { recognized: false, version: null, supported: false }; }
    if (!script) return { recognized: false, version: null, supported: false };
    let version = null;
    try {
      const value = JSON.parse(textContent(script).trim());
      if (typeof value === 'string') {
        const match = /^v?(\d+\.\d+\.\d+)$/.exec(value);
        version = match ? match[1] : value;
      }
    } catch { /* A malformed or unknown marker is not adapted. */ }
    if (session) session.anubisVersion = version;
    return { recognized: true, version, supported: version === this.#supportedVersion };
  }

  isPassChallengeRequest(requestUrl) {
    try { return new URL(requestUrl, this.#client.origin).pathname === this.#passChallengePath; } catch { return false; }
  }

  mapClientRequest(requestUrl, session) {
    let clientUrl;
    try { clientUrl = new URL(requestUrl, this.#client.origin); } catch { return requestUrl; }
    if (clientUrl.pathname !== this.#passChallengePath) return requestUrl;
    if (session?.anubisVersion !== this.#supportedVersion) throw new Error('unsupported Anubis version for PassChallenge mapping');
    const redirs = clientUrl.searchParams.getAll('redir');
    if (redirs.length !== 1) throw new Error('PassChallenge must contain exactly one redir');
    let redir;
    try { redir = new URL(redirs[0]); } catch { throw new Error('PassChallenge redir must be an absolute HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(redir.protocol) || redir.origin !== this.#client.origin || redir.username || redir.password) throw new Error('PassChallenge redir must use the configured client origin');
    if (!safePath(redir.pathname)) throw new Error('PassChallenge redir contains an unsafe redirect path');
    redir.protocol = this.#upstream.protocol;
    redir.host = this.#upstream.host;
    redir.port = this.#upstream.port;
    clientUrl.searchParams.set('redir', redir.href);
    return `${clientUrl.pathname}${clientUrl.search}`;
  }

  mapUpstreamLocation(location, requestUrl, statusCode) {
    let request;
    try { request = new URL(requestUrl, this.#client.origin); } catch { return location; }
    if (request.pathname !== this.#passChallengePath || statusCode < 300 || statusCode >= 400 || !location) return location;
    let target;
    try { target = new URL(location); } catch { throw new Error('PassChallenge returned a non-absolute Location'); }
    if (target.origin !== this.#upstream.origin || !['http:', 'https:'].includes(target.protocol) || target.username || target.password || !safePath(target.pathname)) {
      throw new Error('PassChallenge returned an unexpected Location');
    }
    target.protocol = this.#client.protocol;
    target.host = this.#client.host;
    target.port = this.#client.port;
    return target.href;
  }

  processSetCookie(setCookie, session) {
    if (typeof setCookie !== 'string') throw new TypeError('Set-Cookie must be a string');
    const parts = setCookie.split(';');
    const nameValue = parts[0].trim();
    const separator = nameValue.indexOf('=');
    if (separator <= 0) return { kind: 'application', cookie: setCookie, cookieNames: [] };
    const name = nameValue.slice(0, separator).trim();
    const prefix = escapeRegExp(this.#cookiePrefix);
    const isAnubis = new RegExp(`^${prefix}-(?:auth|cookie-verification|original-referer)(?:-[a-f0-9]{8})?$`, 'i').test(name);
    if (!isAnubis) return { kind: 'application', cookie: setCookie, cookieNames: [] };

    const output = [parts[0].trim()];
    const attributes = { domain: 'host-only', path: null, secure: false, httpOnly: false, sameSite: null, partitioned: false, expires: false, maxAge: false, deletion: false };
    for (const rawAttribute of parts.slice(1)) {
      const attribute = rawAttribute.trim();
      const match = /^domain\s*=\s*(.*)$/i.exec(attribute);
      if (!match) {
        if (/^secure$/i.test(attribute)) attributes.secure = true;
        else if (/^httponly$/i.test(attribute)) attributes.httpOnly = true;
        else if (/^partitioned$/i.test(attribute)) attributes.partitioned = true;
        else if (/^path\s*=/i.test(attribute)) attributes.path = attribute.slice(attribute.indexOf('=') + 1).trim();
        else if (/^samesite\s*=/i.test(attribute)) attributes.sameSite = attribute.slice(attribute.indexOf('=') + 1).trim();
        else if (/^expires\s*=/i.test(attribute)) attributes.expires = true;
        else if (/^max-age\s*=/i.test(attribute)) {
          attributes.maxAge = true;
          attributes.deletion = /^max-age\s*=\s*-?0\s*$/i.test(attribute);
        }
        output.push(attribute);
        continue;
      }
      const domain = match[1].trim().replace(/^\./, '').toLowerCase();
      if (domain !== this.#upstream.hostname.toLowerCase()) throw new Error('unexpected Anubis cookie Domain');
      attributes.domain = 'upstream-domain-mapped-to-client-host-only';
    }
    session?.upstreamBrowserCookieNames?.add(name);
    return { kind: 'anubis', cookie: output.join('; '), cookieNames: [name], attributeSummary: attributes };
  }
}
