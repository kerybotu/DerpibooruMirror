export function validateCookieName(setCookie, prefix) {
  if (typeof setCookie !== 'string') throw new TypeError('Set-Cookie must be a string');
  const pair = setCookie.split(';', 1)[0].trim();
  const separator = pair.indexOf('=');
  if (separator < 1) return;
  const name = pair.slice(0, separator).trim();
  if (!name.startsWith(`${prefix}-`)) return;
  // lib/http.go cookieName: base + '-' + hex(SHA256(settings)[0:4]).
  // Do not calculate a suffix from proxy settings or invent an auth cookie.
  const tail = name.slice(prefix.length + 1);
  if (!/^(?:auth|cookie-verification)-[a-f0-9]{8}$/.test(tail)) {
    throw new Error('v1.27.0 Anubis cookie requires a known name and settings hash suffix');
  }
}
