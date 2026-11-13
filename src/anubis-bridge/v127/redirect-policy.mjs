// Stricter bridge boundary than 1.27.0 ParseRequestURI: never relax the fixed
// origin rule to match the older server's malformed-input acceptance.
export function validateRedirectText(value, label = 'redirect') {
  if (typeof value !== 'string' || !/^https?:\/\//.test(value) || /[\s\\\u0000-\u001f\u007f]/.test(value) || /%(?![a-f0-9]{2})/i.test(value)) {
    throw new Error(`v1.27.0 ${label} must be a canonical absolute HTTP(S) URL`);
  }
  // Check before WHATWG URL parsing removes dot segments.
  const path = /^https?:\/\/[^/?#]+([^?#]*)/.exec(value)?.[1] || '/';
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { throw new Error(`v1.27.0 ${label} has invalid encoding`); }
  if (decoded.split('/').some(segment => segment === '.' || segment === '..')) throw new Error(`v1.27.0 ${label} has an unsafe redirect path`);
}
