import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ClientGateway, UpstreamGateway, ProxyEngine, SessionManager } from '../src/index.mjs';

const passPath = '/.within.website/x/cmd/anubis/api/pass-challenge';
const logicalOrigin = 'https://source.test';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const request = (port, path, cookie = '', method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { cookie, accept: 'text/html' } }, res => {
    const chunks = [];
    res.on('data', data => chunks.push(data));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
  });
  req.on('error', reject);
  req.end();
});

// This server is a transport fixture, not an Anubis implementation. It does not
// validate PoW or mint JWTs, and no test here establishes authenticated access.
async function fixture(t) {
  const observed = [];
  const html = '<script id="anubis_version" type="application/json">"v1.27.0"</script>';
  const upstream = http.createServer((req, res) => {
    const url = new URL(req.url, logicalOrigin);
    observed.push({ path: url.pathname, params: url.searchParams, method: req.method, cookie: req.headers.cookie || '', host: req.headers.host });
    if (url.pathname === '/') {
      return res.writeHead(403, { 'content-type': 'text/html', 'set-cookie': 'techaro.lol-anubis-cookie-verification-abcdef12=fixture-only; Domain=source.test; Path=/; HttpOnly; SameSite=Lax' }).end(html);
    }
    if (url.pathname === passPath) {
      if (url.searchParams.get('mode') === 'error') return res.writeHead(400).end('fixture rejection');
      const location = url.searchParams.get('mode') === 'external' ? 'https://external.test/' : `${logicalOrigin}/after?tab=one%20two`;
      return res.writeHead(302, { location }).end();
    }
    if (url.pathname === '/.within.website/x/cmd/anubis/static/js/worker/sha256-purejs.mjs') {
      return res.writeHead(200, { 'content-type': 'application/javascript', 'content-security-policy': "default-src 'self'; worker-src 'self' blob:", etag: 'v127-fixture-worker' }).end('/* v127 resource transport fixture; no PoW execution */');
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ordinary fixture');
  });
  const upPort = await listen(upstream);
  const manager = new SessionManager({ secure: false });
  const engine = new ProxyEngine({ sessionManager: manager });
  let gateway;
  const contexts = [];
  const client = http.createServer(async (req, res) => { const result = await gateway.handle(req, res); contexts.push(result.context); });
  const port = await listen(client);
  const origin = `http://127.0.0.1:${port}`;
  const route = { name: 'v127-local-only', target: `http://127.0.0.1:${upPort}`, upstreamHost: 'source.test', publicOrigin: origin,
    anubisBridge: { enabled: true, supportedVersion: '1.27.0', upstreamOrigin: logicalOrigin } };
  gateway = new ClientGateway({ upstreamGateway: new UpstreamGateway({ engine }), publicOrigin: origin, route });
  t.after(async () => {
    for (const server of [client, upstream]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  const challenge = await request(port, '/');
  assert.equal(challenge.status, 403);
  assert.equal(challenge.body, html);
  const sid = challenge.headers['set-cookie'].find(c => c.startsWith('mirror_sid=')).split(';')[0];
  const testCookie = challenge.headers['set-cookie'].find(c => c.startsWith('techaro.')).split(';')[0];
  assert.doesNotMatch(challenge.headers['set-cookie'].find(c => c.startsWith('techaro.')), /Domain=/i);
  const url = (extra = {}) => `${passPath}?${new URLSearchParams({ id: 'fixture-id', redir: `${origin}/original?tab=recent`, result: 'a'.repeat(64), ...extra })}`;
  return { port, upPort, origin, sid, testCookie, observed, contexts, manager, url };
}

test('v127 real ProxyEngine rejects malformed fields and non-GET before contacting fixture', async t => {
  const f = await fixture(t);
  const cases = [ [f.url({ id: '' }), 'GET'], [f.url({ result: '{}' }), 'GET'], [f.url(), 'POST'], [f.url({ redir: 'http://external.test/' }), 'GET'] ];
  for (const [url, method] of cases) {
    const count = f.observed.length;
    const result = await request(f.port, url, f.sid, method);
    assert.equal(result.status, 502);
    assert.equal(f.observed.length, count, 'invalid PassChallenge must not reach upstream');
    assert.ok(result.headers['x-request-id']);
    assert.equal(f.contexts.at(-1).error_category, 'anubis-bridge-rejected');
    assert.equal(f.contexts.at(-1).error_stage, 'anubis-request-adaptation');
  }
});

test('v127 real ProxyEngine maps fixed logical origin and fixture 302 without claiming auth success', async t => {
  const f = await fixture(t);
  const result = await request(f.port, f.url({ extra: 'untouched+a' }), `${f.sid}; ${f.testCookie}`);
  assert.equal(result.status, 302);
  assert.equal(result.headers.location, `${f.origin}/after?tab=one%20two`);
  const upstream = f.observed.at(-1);
  assert.equal(upstream.params.get('redir'), `${logicalOrigin}/original?tab=recent`);
  assert.equal(upstream.params.get('extra'), 'untouched+a');
  assert.equal(upstream.params.get('result'), 'a'.repeat(64));
  assert.equal(upstream.host, 'source.test');
  assert.equal(upstream.cookie, f.testCookie);
  const s = f.manager.getOrCreate(f.sid).session;
  assert.equal(await f.manager.getUpstreamCookie(s, `http://127.0.0.1:${f.upPort}/`), '');
  const stranger = await request(f.port, '/ordinary', f.testCookie);
  assert.equal(stranger.status, 200);
  assert.equal(f.observed.at(-1).cookie, '');
});

test('v127 upstream errors stay errors and unexpected Location records final rejection context', async t => {
  const f = await fixture(t);
  const failure = await request(f.port, f.url({ mode: 'error' }), f.sid);
  assert.equal(failure.status, 400);
  assert.equal(failure.headers.location, undefined);
  const external = await request(f.port, f.url({ mode: 'external' }), f.sid);
  assert.equal(external.status, 502);
  assert.equal(external.headers.location, undefined);
  assert.equal(f.contexts.at(-1).error_category, 'anubis-bridge-rejected');
  assert.equal(f.contexts.at(-1).error_stage, 'anubis-location-adaptation');
  assert.doesNotMatch(f.contexts.at(-1).error_message, /fixture-id|aaaaaa/);
});

test('v127 worker resource bytes and security headers are forwarded without swapping version assets', async t => {
  const f = await fixture(t);
  const result = await request(f.port, '/.within.website/x/cmd/anubis/static/js/worker/sha256-purejs.mjs?cacheBuster=1.27.0', f.sid);
  assert.equal(result.status, 200);
  assert.equal(result.body, '/* v127 resource transport fixture; no PoW execution */');
  assert.equal(result.headers['content-type'], 'application/javascript');
  assert.equal(result.headers['content-security-policy'], "default-src 'self'; worker-src 'self' blob:");
  assert.equal(result.headers.etag, 'v127-fixture-worker');
  assert.equal(f.observed.at(-1).params.get('cacheBuster'), '1.27.0');
});
