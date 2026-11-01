import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProxyError } from '../src/errors.mjs';
import { RoutePolicy } from '../src/route-policy.mjs';

test('errors have safe categories and 502/504 mappings', () => {
  assert.equal(classifyProxyError({ code: 'ENOTFOUND' }).category, 'dns-failure');
  assert.equal(classifyProxyError({ code: 'ECONNREFUSED' }).statusCode, 502);
  assert.equal(classifyProxyError({ code: 'ETIMEDOUT' }).statusCode, 504);
  assert.equal(classifyProxyError({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }).category, 'tls-handshake-failure');
  assert.equal(classifyProxyError({}, { clientAborted: true }).statusCode, null);
});

test('route policy is fixed and rejects unconfigured route names', () => {
  const policy = new RoutePolicy({ main: { target: 'https://upstream.test', publicOrigin: 'https://mirror.test' } });
  assert.equal(policy.get('main').target, 'https://upstream.test');
  assert.throws(() => policy.get('https://evil.test'));
  assert.throws(() => new RoutePolicy({ bad: { target: 'file:///tmp/x', publicOrigin: 'https://mirror.test' } }));
});
