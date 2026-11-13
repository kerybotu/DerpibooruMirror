import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import { ProxyEngine, SessionManager, RoutePolicy, ClientGateway, UpstreamGateway } from '../src/index.mjs';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function request(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/' }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
  });
}

test('TLS upstream verification accepts an explicitly trusted CA and rejects an untrusted certificate', async (t) => {
  let openssl;
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    openssl = true;
  } catch {
    openssl = false;
  }
  if (!openssl) return t.skip('openssl is unavailable; TLS certificate test not verified');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-tls-'));
  const caKey = path.join(dir, 'ca.key');
  const caCert = path.join(dir, 'ca.crt');
  const serverKey = path.join(dir, 'server.key');
  const serverCsr = path.join(dir, 'server.csr');
  const serverCert = path.join(dir, 'server.crt');
  const ext = path.join(dir, 'ext.cnf');
  fs.writeFileSync(ext, 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', caCert, '-subj', '/CN=Mirror Test CA', '-days', '1'], { stdio: 'ignore' });
  execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', serverKey, '-out', serverCsr, '-subj', '/CN=localhost'], { stdio: 'ignore' });
  execFileSync('openssl', ['x509', '-req', '-in', serverCsr, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial', '-out', serverCert, '-days', '1', '-extfile', ext], { stdio: 'ignore' });

  const upstream = https.createServer({ key: fs.readFileSync(serverKey), cert: fs.readFileSync(serverCert) }, (_req, res) => res.end('tls-ok'));
  const upstreamPort = await listen(upstream);
  const target = `https://localhost:${upstreamPort}`;
  const route = new RoutePolicy({ tls: { target, publicOrigin: 'http://mirror.test' } }).get('tls');
  const goodEngine = new ProxyEngine({ sessionManager: new SessionManager({ secure: false }), upstreamTls: { ca: fs.readFileSync(caCert) } });
  const badErrors = [];
  const badEngine = new ProxyEngine({ sessionManager: new SessionManager({ secure: false }) });
  badEngine.on('error-classified', event => badErrors.push(event));
  const goodMirror = http.createServer((req, res) => goodEngine.handle(req, res, { route }));
  const badGateway = new ClientGateway({ upstreamGateway: new UpstreamGateway({ engine: badEngine }), publicOrigin: 'http://mirror.test', route });
  let badContext;
  const badMirror = http.createServer(async (req, res) => { badContext = (await badGateway.handle(req, res)).context; });
  const goodPort = await listen(goodMirror);
  const badPort = await listen(badMirror);
  t.after(async () => { goodMirror.closeAllConnections(); badMirror.closeAllConnections(); upstream.closeAllConnections(); await close(goodMirror); await close(badMirror); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });

  const good = await request(goodPort);
  assert.equal(good.status, 200); assert.equal(good.body, 'tls-ok');
  const bad = await request(badPort);
  assert.equal(bad.status, 502);
  assert.equal(badErrors.at(-1).category, 'tls-handshake-failure');
  assert.equal(badContext.error_category, 'tls-handshake-failure');
  assert.equal(badContext.error_stage, 'upstream-tls');
  assert.equal(badContext.response_processing_stage, 'error');
});

test('TLS verification cannot be disabled through engine options', () => {
  assert.throws(() => new ProxyEngine({ sessionManager: new SessionManager(), upstreamTls: { secure: false } }));
});
