import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { ProxyEngine, SessionManager, RoutePolicy, UrlRewriter, ClientGateway, UpstreamGateway } from '../src/index.mjs';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function request(port, path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('proxy engine HTTP, cookies, redirects, streams, Range, WebSocket and diagnostics', async (t) => {
  const large = Buffer.alloc(4 * 1024 * 1024, 97);
  const upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/echo') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(Buffer.concat(chunks));
    }
    if (url.pathname === '/cookies') {
      res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': ['user=one; Path=/; HttpOnly; SameSite=Lax', 'prefs=dark; Path=/'] });
      return res.end('set');
    }
    if (url.pathname === '/challenge') {
      res.writeHead(302, { location: '/challenge-next', 'set-cookie': ['challenge=browser; Path=/challenge; HttpOnly'] });
      return res.end();
    }
    if (url.pathname === '/challenge-echo') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(req.headers.cookie || 'none');
    }
    if (url.pathname === '/cookie-echo') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(req.headers.cookie || 'none');
    }
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: '/target?x=1' });
      return res.end();
    }
    if (url.pathname === '/html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<a href="/target">x</a><form action="/submit"></form>');
    }
    if (url.pathname === '/css') {
      res.writeHead(200, { 'content-type': 'text/css' });
      return res.end('a{background:url(/image.png)}');
    }
    if (url.pathname === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ url: '/image.png' }));
    }
    if (url.pathname === '/large') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': large.length });
      return res.end(large);
    }
    if (url.pathname === '/range') {
      if (req.headers.range === 'bytes=99-') {
        res.writeHead(416, { 'content-type': 'video/mp4', 'content-range': 'bytes */100', 'content-length': 0, 'accept-ranges': 'bytes' });
        return res.end();
      }
      res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': 'bytes 10-19/100', 'content-length': 10, 'accept-ranges': 'bytes' });
      return res.end('0123456789');
    }
    if (url.pathname === '/slow') {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (!res.destroyed) res.end('slow');
      return;
    }
    if (url.pathname === '/disconnect') return req.socket.destroy();
    if (url.pathname === '/error') { res.writeHead(503); return res.end('upstream-down'); }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(req.method === 'HEAD' ? undefined : 'ok');
  });
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', ws => ws.on('message', data => ws.send(`echo:${data}`)));
  upstream.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)));
  const upstreamPort = await listen(upstream);
  const target = `http://127.0.0.1:${upstreamPort}`;
  const policy = new RoutePolicy({ main: { target, publicOrigin: 'http://mirror.test', preservePaths: ['/challenge'], passthroughPaths: ['/challenge'] } });
  const sessions = new SessionManager({ secure: false });
  const rewriter = new UrlRewriter({ publicOrigin: 'http://mirror.test', upstreamOrigins: [{ upstreamOrigin: target, mirrorOrigin: 'http://mirror.test' }] });
  const engine = new ProxyEngine({ sessionManager: sessions, urlRewriter: rewriter, proxyTimeoutMs: 100, timeoutMs: 1000, maxRewriteBytes: 1024 });
  const errors = [];
  engine.on('error-classified', event => errors.push(event));
  const mirror = http.createServer((req, res) => engine.handle(req, res, { route: policy.get('main') }));
  mirror.on('upgrade', (req, socket, head) => engine.handleUpgrade(req, socket, head, { route: policy.get('main') }));
  const port = await listen(mirror);
  t.after(async () => { wss.close(); mirror.closeAllConnections(); upstream.closeAllConnections(); await close(mirror); await close(upstream); });

  await t.test('GET and HEAD preserve methods and headers', async () => {
    const get = await request(port, '/');
    assert.equal(get.status, 200); assert.equal(get.body.toString(), 'ok');
    assert.ok(get.headers['x-request-id']);
    const head = await request(port, '/', { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(head.body.length, 0);
  });
  await t.test('POST request body is streamed upstream', async () => {
    const result = await request(port, '/echo', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'payload-123' });
    assert.equal(result.body.toString(), 'payload-123');
  });
  await t.test('server-side cookies are stored and isolated from the browser', async () => {
    const set = await request(port, '/cookies');
    assert.equal(set.headers['set-cookie'].length, 1);
    assert.ok(set.headers['set-cookie'][0].startsWith('mirror_sid='));
    assert.ok(!set.headers['set-cookie'][0].includes('user=one'));
    const cookie = set.headers['set-cookie'][0].split(';')[0];
    const echo = await request(port, '/cookie-echo', { headers: { cookie } });
    assert.ok(echo.body.toString().includes('user=one'));
    const other = await request(port, '/cookie-echo');
    assert.equal(other.body.toString(), 'none');
  });
  await t.test('relative Location maps to mirror origin', async () => {
    const result = await request(port, '/redirect');
    assert.equal(result.status, 302); assert.equal(result.headers.location, 'http://mirror.test/target?x=1');
  });
  await t.test('challenge paths preserve upstream cookies, Location and body', async () => {
    const challenge = await request(port, '/challenge');
    assert.equal(challenge.status, 302);
    assert.equal(challenge.headers.location, '/challenge-next');
    assert.equal(challenge.headers['set-cookie'].length, 1);
    assert.ok(challenge.headers['set-cookie'][0].startsWith('challenge=browser'));
    const echoed = await request(port, '/challenge-echo', { headers: { cookie: 'mirror_sid=ignored; challenge=browser' } });
    assert.equal(echoed.body.toString(), 'challenge=browser');
  });
  await t.test('HTML CSS and JSON use parser-based URL mapping', async () => {
    assert.ok((await request(port, '/html')).body.toString().includes('http://mirror.test/target'));
    assert.ok((await request(port, '/css')).body.toString().includes('http://mirror.test/image.png'));
    assert.equal(JSON.parse((await request(port, '/json')).body).url, 'http://mirror.test/image.png');
  });
  await t.test('Range/206 and 4 MiB binary response remain intact', async () => {
    const ranged = await request(port, '/range', { headers: { Range: 'bytes=10-19' } });
    assert.equal(ranged.status, 206); assert.equal(ranged.headers['content-range'], 'bytes 10-19/100'); assert.equal(ranged.body.length, 10);
    const unsatisfiable = await request(port, '/range', { headers: { Range: 'bytes=99-' } });
    assert.equal(unsatisfiable.status, 416); assert.equal(unsatisfiable.headers['content-range'], 'bytes */100');
    const result = await request(port, '/large');
    assert.equal(result.body.length, large.length); assert.ok(result.body.equals(large));
  });
  await t.test('WebSocket handshake and message forwarding', async () => {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const timer = setTimeout(() => reject(new Error('ws timeout')), 2000);
      ws.on('open', () => ws.send('hello'));
      ws.on('message', data => { clearTimeout(timer); assert.equal(data.toString(), 'echo:hello'); ws.close(); resolve(); });
      ws.on('error', reject);
    });
  });
  await t.test('upstream HTTP error remains original', async () => {
    const result = await request(port, '/error');
    assert.equal(result.status, 503); assert.equal(result.body.toString(), 'upstream-down');
  });
  await t.test('timeout and disconnect become safe error responses', async () => {
    const slow = await request(port, '/slow');
    assert.equal(slow.status, 504);
    const disconnected = await request(port, '/disconnect');
    assert.equal(disconnected.status, 502);
    assert.ok(errors.length >= 2);
  });
  await t.test('DNS failure is classified as 502 without opening an arbitrary upstream', async () => {
    const dnsSessions = new SessionManager({ secure: false });
    const dnsErrors = [];
    const dnsEngine = new ProxyEngine({ sessionManager: dnsSessions, proxyTimeoutMs: 250, timeoutMs: 250 });
    dnsEngine.on('error-classified', event => dnsErrors.push(event));
    const dnsRoute = new RoutePolicy({ missing: { target: 'http://does-not-exist.invalid', publicOrigin: 'http://mirror.test' } }).get('missing');
    const dnsGateway = new ClientGateway({ upstreamGateway: new UpstreamGateway({ engine: dnsEngine }), publicOrigin: 'http://mirror.test', route: dnsRoute });
    let dnsContext;
    const dnsMirror = http.createServer(async (req, res) => { dnsContext = (await dnsGateway.handle(req, res)).context; });
    const dnsPort = await listen(dnsMirror);
    try {
      const result = await request(dnsPort, '/');
      assert.equal(result.status, 502);
      assert.equal(dnsErrors.at(-1).category, 'dns-failure');
      assert.equal(dnsContext.error_category, 'dns-failure');
      assert.equal(dnsContext.error_stage, 'upstream-dns');
      assert.equal(dnsContext.response_processing_stage, 'error');
    } finally {
      dnsMirror.closeAllConnections();
      await close(dnsMirror);
    }
  });
  await t.test('client cancellation is not converted into a second response', async () => {
    await new Promise((resolve) => {
      const client = http.get({ hostname: '127.0.0.1', port, path: '/slow' });
      client.once('error', () => resolve());
      setTimeout(() => client.destroy(), 10);
    });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.ok(errors.some(event => event.category === 'client-aborted'));
  });
});
