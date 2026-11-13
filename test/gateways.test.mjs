import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { ClientGateway, UpstreamGateway, ProxyEngine, SessionManager, createRequestContext } from '../src/index.mjs';

const listen = (server) => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise(resolve => server.close(resolve));
const get = (port, path, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ hostname: '127.0.0.1', port, path, headers }, res => {
    const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
  }); req.on('error', reject); req.end();
});

test('ClientGateway and UpstreamGateway keep separate origins and status context', async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/challenge') return res.writeHead(302, { location: '/next', 'set-cookie': ['challenge=1; Path=/'] }).end();
    if (req.url.startsWith('/.within.website/')) return res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': ['anubis_test=opaque; Path=/.within.website; Secure; HttpOnly; SameSite=None'] }).end(req.headers.cookie || 'no-cookie');
    res.writeHead(200, { 'content-type': 'text/plain' }).end('upstream');
  });
  const upstreamPort = await listen(upstream);
  const engine = new ProxyEngine({ sessionManager: new SessionManager({ secure: false }) });
  const upstreamGateway = new UpstreamGateway({ engine });
  const clientGateway = new ClientGateway({
    upstreamGateway,
    publicOrigin: 'http://mirror.test',
    route: { name: 'derpi', target: `http://127.0.0.1:${upstreamPort}`, preservePaths: ['/.within.website/'], passthroughPaths: ['/.within.website/'] },
  });
  let lastContext;
  const client = http.createServer(async (req, res) => { const result = await clientGateway.handle(req, res); lastContext = result.context; });
  const upstreamStatuses = [];
  const clientStatuses = [];
  engine.on('upstream-response', event => upstreamStatuses.push(event.upstreamStatus));
  clientGateway.on('client-response', event => clientStatuses.push(event.clientStatus));
  const clientPort = await listen(client);
  try {
    const first = await get(clientPort, '/challenge');
    assert.equal(first.status, 302);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(lastContext.client_origin, 'http://mirror.test');
    assert.equal(lastContext.upstream_origin, `http://127.0.0.1:${upstreamPort}`);
    assert.equal(lastContext.upstream_status, 302);
    assert.equal(lastContext.client_status, 302);
    assert.deepEqual(upstreamStatuses, [302]);
    assert.deepEqual(clientStatuses, [302]);
    assert.deepEqual(lastContext.redirect_chain.map(item => item.direction), ['upstream-response', 'client-response']);
    assert.equal(lastContext.redirect_chain[0].location, '/next');
    assert.equal(lastContext.cookie_processing_summary.received, 1);
    assert.equal(lastContext.protocol_flow, 'ordinary');

    const challenge = await get(clientPort, '/.within.website/x/cmd/anubis/api/pass-challenge?redir=%2F', { cookie: 'anubis_test=incoming; mirror_sid=not-forwarded' });
    assert.equal(challenge.status, 200);
    assert.equal(challenge.body, 'anubis_test=incoming');
    assert.match(challenge.headers['set-cookie'][0], /^anubis_test=opaque;/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(lastContext.protocol_flow, 'anubis-or-edge-challenge');
    assert.equal(lastContext.cookie_processing_summary.forwarded, true);
    assert.equal(lastContext.cookie_processing_summary.stored, 0);
    assert.deepEqual(upstreamStatuses, [302, 200]);
    assert.deepEqual(clientStatuses, [302, 200]);
  } finally { await close(client); await close(upstream); }
});

test('failed upstream response keeps the first error in the final RequestContext', async () => {
  const upstream = http.createServer((_req, res) => res.destroy());
  const upstreamPort = await listen(upstream);
  const engine = new ProxyEngine({ sessionManager: new SessionManager({ secure: false }), proxyTimeoutMs: 250, timeoutMs: 250 });
  const upstreamGateway = new UpstreamGateway({ engine });
  const clientGateway = new ClientGateway({
    upstreamGateway,
    publicOrigin: 'http://mirror.test',
    route: { name: 'broken', target: `http://127.0.0.1:${upstreamPort}` },
  });
  let lastContext;
  const client = http.createServer(async (req, res) => { const result = await clientGateway.handle(req, res); lastContext = result.context; });
  const clientPort = await listen(client);
  try {
    const result = await get(clientPort, '/');
    assert.equal(result.status, 502);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(lastContext.error_category, 'upstream-connect-failure');
    assert.equal(lastContext.error_stage, 'upstream-connect');
    assert.equal(lastContext.response_processing_stage, 'error');
    assert.equal(lastContext.client_aborted, false);
    assert.equal(lastContext.error_events.length, 1);
  } finally { await close(client); await close(upstream); }
});

test('response parse failure is retained after the error response finishes', async () => {
  const upstream = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<p>bad</p>'));
  const upstreamPort = await listen(upstream);
  const rewriter = { rewriteHtml() { throw Object.assign(new Error('parser secret=token'), { code: 'PARSE_FAILED' }); } };
  const engine = new ProxyEngine({ sessionManager: new SessionManager({ secure: false }), urlRewriter: rewriter });
  const upstreamGateway = new UpstreamGateway({ engine });
  const clientGateway = new ClientGateway({ upstreamGateway, publicOrigin: 'http://mirror.test', route: { name: 'parse', target: `http://127.0.0.1:${upstreamPort}` } });
  let lastContext;
  const client = http.createServer(async (req, res) => { const result = await clientGateway.handle(req, res); lastContext = result.context; });
  const clientPort = await listen(client);
  try {
    const result = await get(clientPort, '/');
    assert.equal(result.status, 200);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(lastContext.error_category, 'response-parse-failure');
    assert.equal(lastContext.error_stage, 'response-parse');
    assert.equal(lastContext.response_processing_stage, 'error');
    assert.match(lastContext.error_message, /parser/);
    assert.doesNotMatch(lastContext.error_message, /token/);
  } finally { await close(client); await close(upstream); }
});

test('refused upstream connection records its root category and stage', async () => {
  const probe = http.createServer();
  const unusedPort = await listen(probe);
  await close(probe);
  const engine = new ProxyEngine({ sessionManager: new SessionManager({ secure: false }) });
  const gateway = new ClientGateway({ upstreamGateway: new UpstreamGateway({ engine }), publicOrigin: 'http://mirror.test', route: { name: 'refused', target: `http://127.0.0.1:${unusedPort}` } });
  let context;
  const client = http.createServer(async (req, res) => { context = (await gateway.handle(req, res)).context; });
  const port = await listen(client);
  try {
    assert.equal((await get(port, '/')).status, 502);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(context.error_category, 'upstream-connect-failure');
    assert.equal(context.error_stage, 'upstream-connect');
    assert.equal(context.client_aborted, false);
  } finally { await close(client); }
});

test('upstream timeout records a timeout stage and final error state', async () => {
  const upstream = http.createServer(() => {});
  const upstreamPort = await listen(upstream);
  const engine = new ProxyEngine({ sessionManager: new SessionManager({ secure: false }), proxyTimeoutMs: 100, timeoutMs: 200 });
  const gateway = new ClientGateway({ upstreamGateway: new UpstreamGateway({ engine }), publicOrigin: 'http://mirror.test', route: { name: 'timeout', target: `http://127.0.0.1:${upstreamPort}` } });
  let context;
  const client = http.createServer(async (req, res) => { context = (await gateway.handle(req, res)).context; });
  const port = await listen(client);
  try {
    assert.equal((await get(port, '/')).status, 504);
    assert.equal(context.error_category, 'upstream-timeout');
    assert.equal(context.error_stage, 'upstream-timeout');
    assert.equal(context.response_processing_stage, 'error');
  } finally { await close(client); await close(upstream); }
});

test('client response close is retained as an abort and is not normal completion', async () => {
  const upstream = http.createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' }); res.write('first');
    await new Promise(resolve => setTimeout(resolve, 150));
    if (!res.destroyed) res.end('last');
  });
  const upstreamPort = await listen(upstream);
  const engine = new ProxyEngine({ sessionManager: new SessionManager({ secure: false }), proxyTimeoutMs: 1000, timeoutMs: 1500 });
  const gateway = new ClientGateway({ upstreamGateway: new UpstreamGateway({ engine }), publicOrigin: 'http://mirror.test', route: { name: 'abort', target: `http://127.0.0.1:${upstreamPort}` } });
  let context;
  const client = http.createServer(async (req, res) => { context = (await gateway.handle(req, res)).context; });
  const port = await listen(client);
  try {
    await new Promise(resolve => {
      const req = http.get({ hostname: '127.0.0.1', port, path: '/' }, res => { res.once('data', () => { req.destroy(); resolve(); }); });
      req.once('error', resolve);
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(context.error_category, 'client-aborted');
    assert.equal(context.error_stage, 'client-response');
    assert.equal(context.client_aborted, true);
    assert.equal(context.response_processing_stage, 'error');
  } finally { await close(client); await close(upstream); }
});

test('WebSocket cookie retrieval failure is captured in RequestContext', async () => {
  const engine = new ProxyEngine({ sessionManager: {
    getOrCreate: () => ({ session: {}, isNew: false }),
    getUpstreamCookie: async () => { throw new Error('cookie=secret-token'); },
    browserCookiesForPassthrough: () => '',
  } });
  const context = createRequestContext({ headers: { host: 'mirror.test' }, url: '/ws' }, { publicOrigin: 'http://mirror.test', upstreamOrigin: 'http://upstream.test' });
  const socket = { destroyed: false, once() { return this; }, destroy() { this.destroyed = true; } };
  const req = { method: 'GET', url: '/ws', headers: { host: 'mirror.test', cookie: '' } };
  engine.handleUpgrade(req, socket, Buffer.alloc(0), { route: { name: 'ws', target: 'http://upstream.test' }, requestContext: context });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.error_category, 'websocket-cookie-failure');
  assert.equal(context.error_stage, 'websocket-cookie');
  assert.equal(context.client_aborted, false);
  assert.doesNotMatch(context.error_message, /secret-token/);
  assert.equal(context.error_events.length, 1);
});

test('WebSocket upstream connection failure is recorded in RequestContext', async () => {
  const probe = http.createServer();
  const unusedPort = await listen(probe);
  await close(probe);
  const engine = new ProxyEngine({ sessionManager: new SessionManager({ secure: false }) });
  const gateway = new ClientGateway({ upstreamGateway: new UpstreamGateway({ engine }), publicOrigin: 'http://mirror.test', route: { name: 'ws-fail', target: `http://127.0.0.1:${unusedPort}` } });
  let context;
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => { context = gateway.upgrade(req, socket, head).context; });
  const port = await listen(server);
  let ws;
  try {
    await new Promise(resolve => {
      ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.once('error', resolve);
      ws.once('close', resolve);
      setTimeout(resolve, 500);
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(context.error_category, 'upstream-connect-failure', JSON.stringify(context));
    assert.equal(context.error_stage, 'websocket-connect', JSON.stringify(context));
    assert.equal(context.response_processing_stage, 'error', JSON.stringify(context));
  } finally { ws?.terminate(); server.closeAllConnections(); await close(server); }
});

test('upstream response stream interruption is distinct from client abort', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write('partial');
    setTimeout(() => res.destroy(), 20);
  });
  const upstreamPort = await listen(upstream);
  const engine = new ProxyEngine({ sessionManager: new SessionManager({ secure: false }) });
  const gateway = new ClientGateway({ upstreamGateway: new UpstreamGateway({ engine }), publicOrigin: 'http://mirror.test', route: { name: 'stream-fail', target: `http://127.0.0.1:${upstreamPort}` } });
  let context;
  const client = http.createServer(async (req, res) => { context = (await gateway.handle(req, res)).context; });
  const port = await listen(client);
  try {
    await new Promise(resolve => {
      const req = http.get({ hostname: '127.0.0.1', port, path: '/' }, res => {
        res.on('aborted', resolve);
        res.on('error', resolve);
        res.resume();
      });
      req.on('error', resolve);
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(context.error_category, 'upstream-response-interrupted');
    assert.equal(context.error_stage, 'upstream-response-stream');
    assert.equal(context.client_aborted, false);
  } finally { await close(client); await close(upstream); }
});

test('WebSocket upstream handshake rejection is retained as an upstream error', async () => {
  const upstream = http.createServer();
  upstream.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'));
  const upstreamPort = await listen(upstream);
  const engine = new ProxyEngine({ sessionManager: new SessionManager({ secure: false }) });
  const gateway = new ClientGateway({ upstreamGateway: new UpstreamGateway({ engine }), publicOrigin: 'http://mirror.test', route: { name: 'ws-close', target: `http://127.0.0.1:${upstreamPort}` } });
  let context;
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => { context = gateway.upgrade(req, socket, head).context; });
  const port = await listen(server);
  let ws;
  try {
    await new Promise(resolve => {
      ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.once('error', resolve); ws.once('close', resolve); setTimeout(resolve, 500);
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(context.error_category, 'websocket-upstream-rejected');
    assert.equal(context.error_stage, 'websocket-handshake');
    assert.equal(context.error_events.length > 0, true);
  } finally { ws?.terminate(); server.closeAllConnections(); await close(server); await close(upstream); }
});

test('WebSocket abnormal close code and reason are retained with reason redaction', async () => {
  const upstream = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  upstream.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => {
    wss.emit('connection', ws, req);
    setTimeout(() => ws.close(1011, 'token=private'), 10);
  }));
  const upstreamPort = await listen(upstream);
  const engine = new ProxyEngine({ sessionManager: new SessionManager({ secure: false }) });
  const gateway = new ClientGateway({ upstreamGateway: new UpstreamGateway({ engine }), publicOrigin: 'http://mirror.test', route: { name: 'ws-abnormal', target: `http://127.0.0.1:${upstreamPort}` } });
  let context;
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => { context = gateway.upgrade(req, socket, head).context; });
  const port = await listen(server);
  let ws;
  try {
    await new Promise(resolve => {
      ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.once('close', resolve); ws.once('error', resolve); setTimeout(resolve, 500);
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(context.error_category, 'websocket-abnormal-close');
    assert.equal(context.error_stage, 'websocket-lifecycle');
    assert.equal(context.error_events[0].details.closeCode, 1011);
    assert.equal(context.error_events[0].details.closeReason, 'token=[redacted]');
    assert.doesNotMatch(JSON.stringify(context), /private/);
  } finally { ws?.terminate(); wss.close(); server.closeAllConnections(); await close(server); await close(upstream); }
});
