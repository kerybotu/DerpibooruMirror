import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { ClientGateway, UpstreamGateway, ProxyEngine, SessionManager } from '../src/index.mjs';

const anubisBinary = process.env.ANUBIS_BIN;
const chromeBinary = process.env.CHROME_BIN || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!anubisBinary || !fs.existsSync(anubisBinary)) throw new Error('Set ANUBIS_BIN to a locally built Anubis v1.28.2 executable');
if (!fs.existsSync(chromeBinary)) throw new Error('Set CHROME_BIN to Chrome');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  if (!server?.listening) return Promise.resolve();
  server.closeAllConnections?.();
  return new Promise(resolve => server.close(() => resolve()));
}

function readJson(url) {
  return new Promise((resolve, reject) => http.get(url, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
  }).on('error', reject));
}

function cdpSend(socket, method, params = {}) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const onMessage = raw => {
      const message = JSON.parse(raw.toString());
      if (message.id !== id) return;
      socket.off('message', onMessage);
      if (message.error) reject(new Error(`${method}: ${message.error.message}`));
      else resolve(message.result || {});
    };
    socket.on('message', onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function waitFor(predicate, timeoutMs, description) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await predicate();
    if (last) return last;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${description}; last=${JSON.stringify(last)}`);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-bridge-chrome-'));
const cert = path.join(temp, 'localhost.pem');
const key = path.join(temp, 'localhost-key.pem');
const policyFile = path.join(temp, 'policy.yaml');
const profile = path.join(temp, 'chrome-profile');
const cookiePrefix = 'private-lab-anubis';
const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const videoBytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
let app;
let anubis;
let mirror;
let chrome;
let browserSocket;
let tabSocket;
const failures = [];
const requests = [];
const consoleErrors = [];
const anubisLogs = [];
const appObservations = [];

try {
  const openssl = spawn('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
  ], { stdio: 'ignore' });
  const opensslCode = await new Promise(resolve => openssl.once('exit', resolve));
  assert.equal(opensslCode, 0, 'openssl should create an isolated localhost certificate');

  app = http.createServer((req, res) => {
    const names = String(req.headers.cookie || '').split(';').map(part => part.split('=', 1)[0].trim()).filter(Boolean);
    appObservations.push({ path: req.url.split('?', 1)[0], cookieNames: names, range: req.headers.range || null });
    if (req.url === '/image.png') return res.writeHead(200, { 'content-type': 'image/png', 'content-length': imageBytes.length }).end(imageBytes);
    if (req.url === '/video.mp4') {
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      if (!match) return res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': videoBytes.length, 'accept-ranges': 'bytes' }).end(videoBytes);
      const start = Number(match[1]);
      const end = Math.min(match[2] ? Number(match[2]) : videoBytes.length - 1, videoBytes.length - 1);
      if (start >= videoBytes.length || end < start) return res.writeHead(416, { 'content-range': `bytes */${videoBytes.length}` }).end();
      const part = videoBytes.subarray(start, end + 1);
      return res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': `bytes ${start}-${end}/${videoBytes.length}`, 'content-length': part.length, 'accept-ranges': 'bytes' }).end(part);
    }
    if (req.url === '/api/session') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, cookieNames: names }));
    if (req.url === '/') {
      const body = `<!doctype html><html><head><title>Local protected app</title></head><body><main id="app-ready">LOCAL_ANUBIS_PROTECTED_APP</main><img id="test-image" src="/image.png"><script>fetch('/api/session').then(r=>r.json()).then(x=>document.body.dataset.apiOk=String(x.ok));fetch('/video.mp4',{headers:{Range:'bytes=16-31'}}).then(r=>{document.body.dataset.rangeStatus=String(r.status);document.body.dataset.rangeBytes=String(r.headers.get('content-range'))});</script></body></html>`;
      return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' }).end(body);
    }
    res.writeHead(404).end();
  });
  const appPort = await listen(app);

  fs.writeFileSync(policyFile, [
    'bots:',
    '  - name: browser-pow',
    '    user_agent_regex: Chrome',
    '    action: CHALLENGE',
    '    challenge:',
    '      algorithm: sha256',
    '      difficulty: 1',
    'status_codes:',
    '  CHALLENGE: 403',
    '  DENY: 403',
    '',
  ].join('\n'));

  const anubisProbe = http.createServer();
  const anubisPort = await listen(anubisProbe);
  await close(anubisProbe);
  // v1.28.2 parses redirect-domain entries as URL-like values before
  // comparing the resulting host string. `localhost:port` is accepted as a
  // host-pattern entry, while a bare IPv4 address with a port is rejected by
  // net/url as an invalid scheme. The browser-facing origin remains HTTPS;
  // this value only configures the local Anubis allow-list for U.
  const allowedRedirect = `localhost:${anubisPort}`;
  anubis = spawn(anubisBinary, [
    '--bind', `127.0.0.1:${anubisPort}`,
    '--metrics-bind', '127.0.0.1:0',
    '--target', `http://127.0.0.1:${appPort}`,
    '--public-url', `http://localhost:${anubisPort}`,
    '--policy-fname', policyFile,
    '--redirect-domains', allowedRedirect,
    '--cookie-prefix', cookiePrefix,
    '--cookie-secure=true',
    '--cookie-http-only=true',
    '--jwt-restriction-header=',
    '--slog-level', 'ERROR',
  ], {
    cwd: process.env.ANUBIS_CWD || process.cwd(),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  anubis.stderr.on('data', chunk => anubisLogs.push(chunk.toString().replace(/\r?\n/g, ' ')));
  await waitFor(async () => {
    try { return (await new Promise((resolve, reject) => http.get(`http://127.0.0.1:${anubisPort}/`, response => { response.resume(); resolve(response.statusCode); }).on('error', reject))) !== undefined; }
    catch { return false; }
  }, 30_000, 'Anubis local HTTP listener');

  const sessions = new SessionManager({ secure: true });
  const engine = new ProxyEngine({ sessionManager: sessions, urlRewriter: null, proxyTimeoutMs: 15_000, timeoutMs: 15_000 });
  engine.on('error-classified', event => failures.push({ category: event.category, code: event.code, status: event.statusCode }));
  engine.on('anubis-challenge', event => requests.push({ type: 'challenge', version: event.version, supported: event.supported, status: event.statusCode }));
  engine.on('anubis-mapping', event => requests.push({ type: 'mapping', direction: event.direction, from: event.from_origin, to: event.to_origin }));
  engine.on('anubis-cookie-summary', event => requests.push({ type: 'cookies', names: event.cookies.map(cookie => cookie.name), attributes: event.cookies.map(cookie => cookie.attributes) }));
  const mirrorProbe = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) });
  const mirrorPort = await listen(mirrorProbe);
  await close(mirrorProbe);
  const clientOrigin = `https://localhost:${mirrorPort}`;
  const route = {
    name: 'local-anubis',
    target: `http://127.0.0.1:${anubisPort}`,
    publicOrigin: clientOrigin,
    preservePaths: ['/.within.website/'],
    passthroughPaths: ['/.within.website/'],
    anubisBridge: { enabled: true, supportedVersion: '1.28.2', cookiePrefix },
  };
  const gateway = new ClientGateway({ upstreamGateway: new UpstreamGateway({ engine }), publicOrigin: clientOrigin, route });
  mirror = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, async (req, res) => gateway.handle(req, res));
  await listen(mirror);

  const chromeProbe = http.createServer();
  const chromeDebugPort = await listen(chromeProbe);
  await close(chromeProbe);
  chrome = spawn(chromeBinary, [
    `--remote-debugging-port=${chromeDebugPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--ignore-certificate-errors', 'about:blank',
  ], { stdio: 'ignore' });
  const browserInfo = await waitFor(async () => {
    try { return await readJson(`http://127.0.0.1:${chromeDebugPort}/json/version`); } catch { return false; }
  }, 30_000, 'Chrome DevTools endpoint');
  browserSocket = new WebSocket(browserInfo.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { browserSocket.once('open', resolve); browserSocket.once('error', reject); });
  await cdpSend(browserSocket, 'Target.createTarget', { url: 'about:blank' });
  const targets = await waitFor(async () => {
    const value = await readJson(`http://127.0.0.1:${chromeDebugPort}/json/list`);
    return value.find(target => target.type === 'page' && target.url === 'about:blank') || false;
  }, 10_000, 'Chrome page target');
  tabSocket = new WebSocket(targets.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { tabSocket.once('open', resolve); tabSocket.once('error', reject); });
  tabSocket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.method === 'Runtime.exceptionThrown') consoleErrors.push('JavaScript exception');
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push('Console error');
    if (message.method === 'Network.responseReceived') {
      const item = message.params;
      let pathname = '/';
      try { pathname = new URL(item.response.url).pathname; } catch { /* omit malformed URL */ }
      requests.push({ type: item.type, path: pathname, status: item.response.status, mimeType: item.response.mimeType });
    }
  });
  await cdpSend(tabSocket, 'Page.enable');
  await cdpSend(tabSocket, 'Runtime.enable');
  await cdpSend(tabSocket, 'Network.enable');
  await cdpSend(tabSocket, 'Page.navigate', { url: `${clientOrigin}/` });

  const result = await waitFor(async () => {
    const evaluated = await cdpSend(tabSocket, 'Runtime.evaluate', {
      expression: `JSON.stringify({title:document.title,body:document.body?.innerText||'',api:document.body?.dataset?.apiOk||null,rangeStatus:document.body?.dataset?.rangeStatus||null,range:document.body?.dataset?.rangeBytes||null,image:document.querySelector('#test-image')?.complete&&document.querySelector('#test-image')?.naturalWidth>0,href:location.href,cookieNames:document.cookie.split(';').map(x=>x.split('=')[0].trim()).filter(Boolean)})`,
      returnByValue: true,
    });
    try { return JSON.parse(evaluated.result.value); } catch { return false; }
  }, 120_000, 'real Anubis challenge and protected application page');
  assert.match(result.body, /LOCAL_ANUBIS_PROTECTED_APP/);
  assert.equal(result.api, 'true');
  assert.equal(result.rangeStatus, '206');
  assert.match(result.range, /^bytes 16-31\//);
  assert.equal(result.image, true);
  assert.ok(requests.some(request => request.type === 'challenge' && request.version === '1.28.2' && request.supported));
  assert.deepEqual(requests.filter(request => request.type === 'mapping').map(request => request.direction), ['client-to-upstream', 'upstream-to-client']);
  assert.ok(requests.some(request => request.path === '/.within.website/x/cmd/anubis/api/pass-challenge' && request.status === 302));
  assert.ok(requests.some(request => request.path.includes('/.within.website/x/cmd/anubis/static/js/') && request.path.endsWith('main.mjs') && request.status === 200));
  assert.ok(requests.some(request => request.path.endsWith('/.within.website/x/cmd/anubis/static/js/worker/wasm.mjs') && request.status === 200));
  assert.ok(requests.some(request => request.path.endsWith('.wasm') && request.status === 200));
  assert.equal(failures.length, 0, `no classified proxy errors expected: ${JSON.stringify(failures)}`);
  assert.ok(appObservations.some(item => item.path === '/' && item.cookieNames.some(name => name.startsWith(`${cookiePrefix}-auth`))));
  assert.ok(appObservations.some(item => item.path === '/video.mp4' && item.range === 'bytes=16-31'));
  assert.doesNotMatch(JSON.stringify({ requests, appObservations, result, consoleErrors }), /issued-by-upstream|Authorization:|Bearer /);

  process.stdout.write(`${JSON.stringify({ status: 'passed', anubisVersion: '1.28.2', browser: 'Chrome', result, requests, appObservations, consoleErrors, failures }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'failed', error: error.message, requests, appObservations, consoleErrors, failures, anubisLogs: anubisLogs.slice(-20) }, null, 2)}\n`);
  throw error;
} finally {
  tabSocket?.close();
  browserSocket?.close();
  for (const child of [chrome, anubis]) {
    if (child && child.exitCode === null) child.kill();
  }
  await close(mirror);
  await close(app);
  fs.rmSync(temp, { recursive: true, force: true });
}
