import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src/index.mjs';

const C = 'http://mirror.test:49123';
const U = 'https://source.test';
const path = '/.within.website/x/cmd/anubis/api/pass-challenge';
const digest = '0'.repeat(64); // Format fixture only; never a validated PoW result.
function bridge(version = '1.27.0', extra = {}) {
  assert.equal(typeof api.createAnubisBridge, 'function', 'version adapter factory is not implemented');
  return api.createAnubisBridge({ clientOrigin: C, upstreamOrigin: U, supportedVersion: version, ...extra });
}
function pass(fields = {}) {
  return `${path}?${new URLSearchParams({ id: 'opaque-id', redir: `${C}/gallery?q=blue%20sky`, response: digest, nonce: '17', elapsedTime: '12.5', ...fields })}`;
}
const session = () => ({ anubisVersion: '1.27.0', upstreamBrowserCookieNames: new Set() });

test('v127 exact marker selects only the explicitly configured version and unknowns fail closed', () => {
  for (const configured of ['1.27.0', '1.28.2']) {
    const b = bridge(configured);
    for (const marker of ['1.27.0', 'v1.27.0', '1.28.2', 'v1.28.2', '1.27.1', '1.27.0-custom']) {
      const s = session();
      const result = b.observeChallengeHtml(s, 'text/html', `<script id="anubis_version" type="application/json">${JSON.stringify(marker)}</script>`);
      assert.equal(result.supported, marker.replace(/^v/, '') === configured);
      if (!result.supported) assert.throws(() => b.mapClientRequest(pass(), s), /unsupported Anubis version/);
    }
  }
  for (const v of ['1.27', '^1.27.0', '1.27.1', '9.9.9']) assert.throws(() => bridge(v), /unsupported Anubis version/);
});

test('v127 preserves PoW bytes, unknown fields and query semantics while mapping only redir', () => {
  const mapped = new URL(bridge().mapClientRequest(pass({ extra: 'a+b%20c', nonce: '+0017' }), session()), U);
  assert.equal(mapped.searchParams.get('redir'), `${U}/gallery?q=blue%20sky`);
  assert.equal(mapped.searchParams.get('id'), 'opaque-id');
  assert.equal(mapped.searchParams.get('response'), digest);
  assert.equal(mapped.searchParams.get('nonce'), '+0017');
  assert.equal(mapped.searchParams.get('elapsedTime'), '12.5');
  assert.equal(mapped.searchParams.get('extra'), 'a+b%20c');
});

test('v127 accepts separate preact and metarefresh contracts without inventing PoW fields', () => {
  const b = bridge();
  for (const fields of [{ result: digest }, { challenge: 'opaque-random-data' }]) {
    const input = `${path}?${new URLSearchParams({ id: 'opaque-id', redir: `${C}/`, ...fields })}`;
    const result = new URL(b.mapClientRequest(input, session()), U);
    assert.equal(result.searchParams.get('redir'), `${U}/`);
    for (const [key, value] of Object.entries(fields)) assert.equal(result.searchParams.get(key), value);
    assert.equal(result.searchParams.has('nonce'), false);
  }
});

test('v127 rejects missing, duplicate and malformed contract fields without disclosing values', () => {
  const b = bridge();
  for (const key of ['id', 'redir', 'nonce', 'response', 'elapsedTime']) {
    const url = new URL(pass(), C);
    url.searchParams.delete(key);
    assert.throws(() => b.mapClientRequest(url.pathname + url.search, session()), /v1.27.0|PassChallenge/);
    assert.throws(() => b.mapClientRequest(`${pass()}&${key}=another`, session()), /v1.27.0|PassChallenge/);
  }
  for (const fields of [{ nonce: '1.5' }, { nonce: '9223372036854775808' }, { elapsedTime: 'NaN' }, { elapsedTime: 'Infinity' }, { elapsedTime: 'null' }, { response: '[object Object]' }, { response: '' }, { id: '\nsecret-value' }, { result: digest }]) {
    assert.throws(() => b.mapClientRequest(pass(fields), session()), error => {
      assert.doesNotMatch(error.message, /secret-value|opaque-id/);
      return true;
    });
  }
  assert.throws(() => b.mapClientRequest(pass(), session(), 'POST'), /GET/);
});

test('v127 only maps fixed canonical redirects and exact successful Location origins', () => {
  const b = bridge();
  for (const redir of ['https://mirror.test:49123/', 'http://evil.test:49123/', 'http://mirror.test:49124/', 'javascript:alert(1)', `${C}//evil.test`, `${C}/%252f%252fevil.test`, `${C}/%2e%2e/x`, `${C}/bad%ZZ`, `${C}/a\\b`, ` ${C}/`]) {
    assert.throws(() => b.mapClientRequest(pass({ redir }), session()), /redirect|redir/);
  }
  assert.equal(b.mapUpstreamLocation(`${U}/after?q=x%20y`, path, 302), `${C}/after?q=x%20y`);
  for (const loc of ['http://source.test/', 'https://evil.test/', 'https://source.test:444/', '/relative', `${U}//evil.test`, `${U}/%252F%252Fevil.test`, `${U}/bad%ZZ`]) {
    assert.throws(() => b.mapUpstreamLocation(loc, path, 302), /Location|redirect/);
  }
  assert.equal(b.mapUpstreamLocation(`${U}/after`, path, 400), `${U}/after`);
  assert.equal(b.mapUpstreamLocation(`${U}/after`, path, 200), `${U}/after`);
  assert.throws(() => b.mapUpstreamLocation(`${U}/after`, path, 307), /302/);
});

test('v127 ordinary paths and resources never activate PassChallenge adaptation', () => {
  const b = bridge();
  for (const url of ['/api?redir=not-a-url', '/.within.website/static/js/main.mjs', `${path}/extra?redir=bad`]) {
    assert.equal(b.mapClientRequest(url, session(), 'POST'), url);
    assert.equal(b.mapUpstreamLocation('https://elsewhere.test/', url, 302), 'https://elsewhere.test/');
  }
});

test('v127 preact and metarefresh reject absent, duplicate and invalid response fields', () => {
  const b = bridge();
  for (const fields of [{ result: digest }, { challenge: 'opaque-random-data' }]) {
    const key = Object.keys(fields)[0];
    for (const value of ['', '\nopaque-value', ...(key === 'result' ? ['[]'] : [])]) {
      const params = new URLSearchParams({ id: 'opaque-id', redir: `${C}/`, [key]: value });
      assert.throws(() => b.mapClientRequest(`${path}?${params}`, session()), /v1.27.0/);
    }
    const params = new URLSearchParams({ id: 'opaque-id', redir: `${C}/`, ...fields });
    assert.throws(() => b.mapClientRequest(`${path}?${params}&${key}=duplicate`, session()), /v1.27.0/);
  }
});

test('v127 custom namespace and base prefix stay explicit and do not activate adjacent paths', () => {
  const b = bridge('1.27.0', { cookiePrefix: 'private-anubis', basePrefix: '/protected' });
  const original = pass();
  assert.equal(b.mapClientRequest(original, session()), original);
  assert.equal(new URL(b.mapClientRequest(`/protected${original}`, session()), U).searchParams.get('redir'), `${U}/gallery?q=blue%20sky`);
  const result = b.processSetCookie('private-anubis-auth-abcdef12=opaque-fixture; Domain=source.test; Path=/protected/; Secure; HttpOnly; SameSite=Lax', session());
  assert.equal(result.kind, 'anubis');
  assert.equal(result.cookie, 'private-anubis-auth-abcdef12=opaque-fixture; Path=/protected/; Secure; HttpOnly; SameSite=Lax');
});

test('v127 requires settings suffix and preserves cookie attributes and deletion', async () => {
  const b = bridge();
  const s = session();
  for (const kind of ['auth', 'cookie-verification']) {
    const name = `techaro.lol-anubis-${kind}-abcdef12`;
    const result = b.processSetCookie(`${name}=opaque-fixture; Domain=source.test; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Expires=Tue, 01 Dec 2026 00:00:00 GMT`, s);
    assert.equal(result.kind, 'anubis');
    assert.equal(result.cookie, `${name}=opaque-fixture; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Expires=Tue, 01 Dec 2026 00:00:00 GMT`);
    assert.equal(result.attributeSummary.partitioned, true);
    assert.equal(result.attributeSummary.expires, true);
    assert.equal(result.attributeSummary.sameSite, 'None');
    assert.ok(s.upstreamBrowserCookieNames.has(name));
    const deleted = b.processSetCookie(`${name}=; Path=/; Max-Age=0`, s);
    assert.equal(deleted.attributeSummary.deletion, true);
  }
  for (const name of ['techaro.lol-anubis-auth', 'techaro.lol-anubis-auth-bad', 'techaro.lol-anubis-auth-ABCDEF12', 'techaro.lol-anubis-original-referer-abcdef12']) {
    assert.throws(() => b.processSetCookie(`${name}=opaque-fixture; Path=/`, s), /v1.27.0.*cookie/);
  }
  assert.throws(() => b.processSetCookie('techaro.lol-anubis-auth-abcdef12=opaque-fixture; Domain=evil.test', s), /Domain/);
  assert.equal(b.processSetCookie('app_session=ordinary; Path=/', s).kind, 'application');
  assert.equal(bridge('1.28.2').processSetCookie('techaro.lol-anubis-auth=opaque-fixture', s).kind, 'anubis');
});

test('v127 cookie registration is session-local and browser cookies are not moved into ordinary jar', async () => {
  const b = bridge();
  const manager = new api.SessionManager({ secure: false });
  const first = manager.getOrCreate().session;
  const second = manager.getOrCreate().session;
  const cookie = 'techaro.lol-anubis-auth-abcdef12=opaque-fixture';
  b.processSetCookie(`${cookie}; Domain=source.test; Path=/`, first);
  assert.equal(await manager.getUpstreamCookieWithBrowserCookies(first, `${U}/`, cookie), cookie);
  assert.equal(await manager.getUpstreamCookieWithBrowserCookies(second, `${U}/`, cookie), '');
  assert.equal(await manager.getUpstreamCookie(first, `${U}/`), '');
});
