import test from 'node:test';
import assert from 'node:assert/strict';
import { AnubisCompatibilityBridge } from '../src/anubis-bridge.mjs';

const clientOrigin = 'https://mirror.test';
const upstreamOrigin = 'https://derpibooru.test';
const cookiePrefix = 'test-anubis';

function createBridge() {
  return new AnubisCompatibilityBridge({ clientOrigin, upstreamOrigin, supportedVersion: '1.28.2', cookiePrefix });
}

function page(version) {
  return `<html><head><script id="anubis_version" type="application/json">${JSON.stringify(version)}</script></head><body>Anubis Challenge</body></html>`;
}

test('Anubis version detection is based on the challenge page marker and fails closed for unknown versions', () => {
  const bridge = createBridge();
  const session = {};

  assert.deepEqual(bridge.observeChallengeHtml(session, 'text/html; charset=utf-8', page('1.28.2')), {
    recognized: true,
    version: '1.28.2',
    supported: true,
  });
  assert.deepEqual(bridge.observeChallengeHtml(session, 'text/html', page('1.29.0')), {
    recognized: true,
    version: '1.29.0',
    supported: false,
  });
  assert.deepEqual(bridge.observeChallengeHtml(session, 'text/html', '<html><body>ordinary</body></html>'), {
    recognized: false,
    version: null,
    supported: false,
  });
});

test('Anubis version detection accepts the v-prefixed marker emitted by v1.28.2', () => {
  const bridge = createBridge();
  const session = {};

  assert.deepEqual(bridge.observeChallengeHtml(session, 'text/html; charset=utf-8', page('v1.28.2')), {
    recognized: true,
    version: '1.28.2',
    supported: true,
  });
  assert.equal(session.anubisVersion, '1.28.2');
});

test('PassChallenge maps only a browser URL on the fixed client origin to the fixed upstream origin', () => {
  const bridge = createBridge();
  const session = { anubisVersion: '1.28.2' };
  const original = '/.within.website/x/cmd/anubis/api/pass-challenge?id=opaque&redir=https%3A%2F%2Fmirror.test%2Fimages%3Fq%3Da%2520b&nonce=123';

  const mapped = bridge.mapClientRequest(original, session);
  const parsed = new URL(mapped, upstreamOrigin);
  assert.equal(parsed.origin, upstreamOrigin);
  assert.equal(parsed.pathname, '/.within.website/x/cmd/anubis/api/pass-challenge');
  assert.equal(parsed.searchParams.get('redir'), 'https://derpibooru.test/images?q=a%20b');
  assert.equal(parsed.searchParams.get('id'), 'opaque');
  assert.equal(parsed.searchParams.get('nonce'), '123');
});

test('PassChallenge removes a non-standard client port when mapping to a default-port upstream origin', () => {
  const bridge = new AnubisCompatibilityBridge({ clientOrigin: 'http://mirror.test:49123', upstreamOrigin: 'https://derpibooru.test', supportedVersion: '1.28.2', cookiePrefix });
  const mapped = bridge.mapClientRequest(`/.within.website/x/cmd/anubis/api/pass-challenge?redir=${encodeURIComponent('http://mirror.test:49123/images')}`, { anubisVersion: '1.28.2' });
  assert.equal(new URLSearchParams(mapped.slice(mapped.indexOf('?') + 1)).get('redir'), 'https://derpibooru.test/images');
});

test('PassChallenge mapping rejects unsupported versions, duplicate parameters and non-fixed targets', () => {
  const bridge = createBridge();
  const path = '/.within.website/x/cmd/anubis/api/pass-challenge';
  assert.throws(() => bridge.mapClientRequest(`${path}?redir=https%3A%2F%2Fmirror.test%2F`, { anubisVersion: '1.29.0' }), /unsupported Anubis version/);
  assert.throws(() => bridge.mapClientRequest(`${path}?redir=https%3A%2F%2Fmirror.test%2F&redir=https%3A%2F%2Fmirror.test%2F`, { anubisVersion: '1.28.2' }), /exactly one redir/);
  assert.throws(() => bridge.mapClientRequest(`${path}?redir=https%3A%2F%2Fevil.test%2F`, { anubisVersion: '1.28.2' }), /client origin/);
  assert.throws(() => bridge.mapClientRequest(`${path}?redir=https%253A%252F%252Fmirror.test%252F`, { anubisVersion: '1.28.2' }), /absolute HTTP/);
  assert.throws(() => bridge.mapClientRequest(`${path}?redir=https%3A%2F%2Fmirror.test%2F%2Fevil.test`, { anubisVersion: '1.28.2' }), /unsafe redirect path/);
  assert.throws(() => bridge.mapClientRequest(`${path}?redir=${encodeURIComponent('https://mirror.test/path%252F%252Fevil.test')}`, { anubisVersion: '1.28.2' }), /unsafe redirect path/);
  assert.equal(bridge.mapClientRequest('/ordinary?redir=https%3A%2F%2Fmirror.test%2F', { anubisVersion: '1.28.2' }), '/ordinary?redir=https%3A%2F%2Fmirror.test%2F');
});

test('PassChallenge Location maps only an exact upstream origin back to the client origin', () => {
  const bridge = createBridge();
  const request = '/.within.website/x/cmd/anubis/api/pass-challenge?redir=...';
  assert.equal(bridge.mapUpstreamLocation('https://derpibooru.test/images?q=one', request, 302), 'https://mirror.test/images?q=one');
  assert.throws(() => bridge.mapUpstreamLocation('https://evil.test/phish', request, 302), /unexpected Location/);
  assert.equal(bridge.mapUpstreamLocation('https://derpibooru.test/images', '/ordinary', 302), 'https://derpibooru.test/images');
  assert.equal(bridge.mapUpstreamLocation('https://derpibooru.test/images', request, 403), 'https://derpibooru.test/images');
});

test('PassChallenge Location restores the configured non-standard client port exactly', () => {
  const bridge = new AnubisCompatibilityBridge({ clientOrigin: 'http://mirror.test:49123', upstreamOrigin: 'https://derpibooru.test', supportedVersion: '1.28.2', cookiePrefix });
  const request = '/.within.website/x/cmd/anubis/api/pass-challenge?redir=...';
  assert.equal(bridge.mapUpstreamLocation('https://derpibooru.test/images', request, 302), 'http://mirror.test:49123/images');
});

test('Anubis cookies become host-only for the client while unrelated cookies remain untouched', () => {
  const bridge = createBridge();
  const session = {};
  const input = 'test-anubis-auth-abcdef12=secret; Domain=.derpibooru.test; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=3600';
  const result = bridge.processSetCookie(input, session);

  assert.equal(result.kind, 'anubis');
  assert.equal(result.cookie, 'test-anubis-auth-abcdef12=secret; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=3600');
  assert.deepEqual(result.cookieNames, ['test-anubis-auth-abcdef12']);
  assert.deepEqual(bridge.processSetCookie('app_session=ordinary; Domain=derpibooru.test; Path=/', session), {
    kind: 'application',
    cookie: 'app_session=ordinary; Domain=derpibooru.test; Path=/',
    cookieNames: [],
  });
  assert.throws(() => bridge.processSetCookie('test-anubis-auth=secret; Domain=evil.test; Path=/', session), /unexpected Anubis cookie Domain/);
});
