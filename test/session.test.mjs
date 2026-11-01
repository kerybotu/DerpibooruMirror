import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../src/session-manager.mjs';

test('session IDs are random, unrecognized IDs cannot select another session', () => {
  const manager = new SessionManager({ secure: false });
  const a = manager.getOrCreate();
  const b = manager.getOrCreate();
  assert.notEqual(a.session.id, b.session.id);
  assert.match(a.session.id, /^[A-Za-z0-9_-]{43}$/);
  const invalid = manager.getOrCreate('mirror_sid=chosen-by-user');
  assert.notEqual(invalid.session.id, 'chosen-by-user');
});

test('upstream cookies set, update, delete and remain isolated by user/origin/path', async () => {
  const manager = new SessionManager({ secure: false });
  const a = manager.getOrCreate().session;
  const b = manager.getOrCreate().session;
  await manager.receiveSetCookies(a, 'https://one.test/private/page', ['sid=a; Path=/private; HttpOnly; Secure; SameSite=Lax']);
  assert.equal(await manager.getUpstreamCookie(a, 'https://one.test/private/page'), 'sid=a');
  assert.equal(await manager.getUpstreamCookie(a, 'https://one.test/other'), '');
  assert.equal(await manager.getUpstreamCookie(b, 'https://one.test/private/page'), '');
  assert.equal(await manager.getUpstreamCookie(a, 'https://two.test/private/page'), '');
  await manager.receiveSetCookies(a, 'https://one.test/private/page', ['sid=updated; Path=/private; Secure']);
  assert.equal(await manager.getUpstreamCookie(a, 'https://one.test/private/page'), 'sid=updated');
  await manager.receiveSetCookies(a, 'https://one.test/private/page', ['sid=; Max-Age=0; Path=/private; Secure']);
  assert.equal(await manager.getUpstreamCookie(a, 'https://one.test/private/page'), '');
});

test('concurrent cookie updates are visible without cross-user sharing', async () => {
  const manager = new SessionManager({ secure: false });
  const a = manager.getOrCreate().session;
  await Promise.all(Array.from({ length: 10 }, (_, i) => manager.receiveSetCookies(a, 'https://one.test/', [`c${i}=${i}; Path=/; Secure`])));
  const header = await manager.getUpstreamCookie(a, 'https://one.test/');
  for (let i = 0; i < 10; i++) assert.ok(header.includes(`c${i}=${i}`));
  manager.destroy(a.id);
  assert.equal(manager.inspect(a.id), null);
});
