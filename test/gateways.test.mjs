import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ClientGateway, UpstreamGateway, ProxyEngine, SessionManager } from '../src/index.mjs';

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
