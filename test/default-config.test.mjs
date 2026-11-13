import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, loadConfig } from '../src/server.mjs';

test('published defaults target Derpibooru and require TLS verification', () => {
  const config = loadConfig();
  assert.equal(config.upstream.origin, 'https://derpibooru.org');
  assert.equal(config.upstream.host, 'derpibooru.org');
  assert.equal(config.upstream.tls_verify, true);
  assert.equal(config.server.host, '127.0.0.1');
  assert.equal(config.server.port, 3000);
  const app = createServer(config);
  assert.equal(app.route.target, 'https://derpibooru.org');
  assert.equal(app.route.upstreamHost, 'derpibooru.org');
});

test('custom upstream requires explicit opt-in and TLS verification cannot be disabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'derpibooru-mirror-config-'));
  const file = path.join(dir, 'config.json');
  const oldOptIn = process.env.ALLOW_CUSTOM_UPSTREAM;
  try {
    fs.writeFileSync(file, JSON.stringify({ upstream: { origin: 'https://example.invalid' } }));
    delete process.env.ALLOW_CUSTOM_UPSTREAM;
    assert.throws(() => loadConfig(file), /Custom upstream requires/);
    process.env.ALLOW_CUSTOM_UPSTREAM = '1';
    fs.writeFileSync(file, JSON.stringify({ upstream: { tls_verify: false } }));
    assert.throws(() => loadConfig(file), /tls_verify must remain true/);
  } finally {
    if (oldOptIn === undefined) delete process.env.ALLOW_CUSTOM_UPSTREAM;
    else process.env.ALLOW_CUSTOM_UPSTREAM = oldOptIn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
