import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ClientGateway, UpstreamGateway, ProxyEngine, SessionManager } from '../src/index.mjs';

const listen = (server) => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise(resolve => server.close(resolve));
const request = (port, path, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ hostname: '127.0.0.1', port, path, headers }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => {
      const buffer = Buffer.concat(chunks);
      resolve({ status: res.statusCode, headers: res.headers, body: buffer.toString(), buffer });
    });
  });
  req.on('error', reject);
  req.end();
});

test('fixed Anubis bridge maps a real browser-shaped flow and isolates auth cookies from the ordinary jar', async () => {
  const prefix = 'test-anubis';
  const challengeHtml = `<html><head><script id="anubis_version" type="application/json">"1.28.2"</script></head><body>challenge fixture</body></html>`;
  let observedPassRedirect;
  let observedPassCookie;
  let observedNormalCookie;
  const wasmBytes = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  const upstream = http.createServer((req, res) => {
    if (req.url === '/') {
      assert.equal(req.headers['accept-encoding'], 'identity');
      res.writeHead(403, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(challengeHtml),
        'cache-control': 'no-store',
        etag: 'challenge-v1',
        'content-security-policy': "default-src 'self'; worker-src 'self' blob:",
        'access-control-allow-origin': 'https://mirror.test',
        'set-cookie': [`${prefix}-cookie-verification-abcd1234=proof; Domain=127.0.0.1; Path=/; Secure; HttpOnly; SameSite=None; Partitioned`],
      });
      return res.end(challengeHtml);
    }
    if (req.url.startsWith('/.within.website/x/cmd/anubis/api/pass-challenge?')) {
      const parsed = new URL(req.url, 'http://upstream.test');
      observedPassRedirect = parsed.searchParams.get('redir');
      observedPassCookie = req.headers.cookie || '';
      res.writeHead(302, {
        location: `http://127.0.0.1:${upstream.address().port}/gallery?verified=1`,
        'set-cookie': [
          `${prefix}-auth-abcd1234=issued-by-upstream; Domain=127.0.0.1; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=3600`,
          `${prefix}-cookie-verification-abcd1234=; Domain=127.0.0.1; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=0`,
        ],
      });
      return res.end();
    }
    if (req.url === '/.within.website/static/worker.js') {
      const worker = 'postMessage("worker-ok")';
      return res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'content-length': Buffer.byteLength(worker),
        'cache-control': 'public, max-age=60',
        etag: 'worker-v1',
        'content-security-policy': "default-src 'self'; worker-src 'self' blob:",
        'access-control-allow-origin': 'http://mirror.test',
      }).end(worker);
    }
    if (req.url === '/.within.website/static/pow.wasm') {
      return res.writeHead(200, {
        'content-type': 'application/wasm',
        'content-length': wasmBytes.length,
        'cache-control': 'public, max-age=60',
        etag: 'wasm-v1',
      }).end(wasmBytes);
    }
    if (req.url === '/gallery') {
      observedNormalCookie = req.headers.cookie || '';
      const authorized = observedNormalCookie.includes(`${prefix}-auth-abcd1234=issued-by-upstream`);
      return res.writeHead(authorized ? 200 : 403, { 'content-type': 'text/plain' }).end(authorized ? 'authorized application response' : 'missing upstream auth cookie');
    }
    res.writeHead(404).end();
  });
  const upstreamPort = await listen(upstream);
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`;
  const sessions = new SessionManager({ secure: false });
  const engine = new ProxyEngine({ sessionManager: sessions });
  const challengeEvents = [];
  const mappingEvents = [];
  const cookieEvents = [];
  engine.on('anubis-challenge', event => challengeEvents.push(event));
  engine.on('anubis-mapping', event => mappingEvents.push(event));
  engine.on('anubis-cookie-summary', event => cookieEvents.push(event));
  const route = {
    name: 'anubis-test',
    target: upstreamOrigin,
    publicOrigin: '',
    passthroughPaths: ['/.within.website/'],
    preservePaths: ['/.within.website/'],
    anubisBridge: { enabled: true, supportedVersion: '1.28.2', cookiePrefix: prefix },
  };
  let gateway;
  let context;
  const client = http.createServer(async (req, res) => { context = (await gateway.handle(req, res)).context; });
  const clientPort = await listen(client);
  route.publicOrigin = `http://127.0.0.1:${clientPort}`;
  gateway = new ClientGateway({ upstreamGateway: new UpstreamGateway({ engine }), publicOrigin: route.publicOrigin, route });
  try {
    const challenge = await request(clientPort, '/', { accept: 'text/html' });
    assert.equal(challenge.status, 403);
    assert.equal(challenge.body, challengeHtml);
    assert.equal(challenge.headers['content-security-policy'], "default-src 'self'; worker-src 'self' blob:");
    assert.equal(challenge.headers['access-control-allow-origin'], 'https://mirror.test');
    assert.equal(challenge.headers.etag, 'challenge-v1');
    assert.equal(challenge.headers['content-length'], String(Buffer.byteLength(challengeHtml)));
    assert.ok(challenge.headers['set-cookie'][0].includes('Path=/'));
    assert.ok(!challenge.headers['set-cookie'][0].toLowerCase().includes('domain='));
    assert.equal(context.anubis_version, '1.28.2');
    assert.deepEqual(challengeEvents.map(event => [event.version, event.supported, event.statusCode]), [['1.28.2', true, 403]]);

    const worker = await request(clientPort, '/.within.website/static/worker.js');
    assert.equal(worker.status, 200);
    assert.equal(worker.headers['content-type'], 'application/javascript; charset=utf-8');
    assert.equal(worker.headers['cache-control'], 'public, max-age=60');
    assert.equal(worker.headers.etag, 'worker-v1');
    assert.equal(worker.headers['content-security-policy'], "default-src 'self'; worker-src 'self' blob:");
    assert.equal(worker.headers['access-control-allow-origin'], 'http://mirror.test');
    assert.equal(worker.body, 'postMessage("worker-ok")');

    const wasm = await request(clientPort, '/.within.website/static/pow.wasm');
    assert.equal(wasm.status, 200);
    assert.equal(wasm.headers['content-type'], 'application/wasm');
    assert.equal(wasm.headers.etag, 'wasm-v1');
    assert.deepEqual(wasm.buffer, wasmBytes);

    const mirrorSid = challenge.headers['set-cookie'].find(value => value.startsWith('mirror_sid='))?.split(';', 1)[0];
    const verificationCookie = challenge.headers['set-cookie'].find(value => value.startsWith(`${prefix}-cookie-verification`))?.split(';', 1)[0];
    assert.ok(mirrorSid);
    assert.ok(verificationCookie);
    const cookieHeader = `${mirrorSid}; ${verificationCookie}`;
    const originalPassUrl = `/.within.website/x/cmd/anubis/api/pass-challenge?id=opaque&response=proof&nonce=17&redir=${encodeURIComponent(`${route.publicOrigin}/gallery?tab=recent`)}&elapsedTime=42`;
    const passed = await request(clientPort, originalPassUrl, { cookie: cookieHeader });
    assert.equal(passed.status, 302);
    assert.equal(observedPassRedirect, `${upstreamOrigin}/gallery?tab=recent`);
    assert.ok(observedPassCookie.includes(`${prefix}-cookie-verification-abcd1234=proof`));
    assert.equal(passed.headers.location, `${route.publicOrigin}/gallery?verified=1`);
    const authSetCookie = passed.headers['set-cookie'].find(value => value.startsWith(`${prefix}-auth`));
    assert.ok(authSetCookie);
    assert.ok(!authSetCookie.toLowerCase().includes('domain='));
    assert.equal(context.cookie_processing_summary.anubisCookies[0].attributes.domain, 'upstream-domain-mapped-to-client-host-only');
    assert.equal(context.cookie_processing_summary.anubisCookies[0].attributes.secure, true);
    assert.equal(context.cookie_processing_summary.anubisCookies[0].attributes.httpOnly, true);
    assert.equal(context.cookie_processing_summary.anubisCookies[0].attributes.sameSite, 'None');
    assert.equal(context.cookie_processing_summary.anubisCookies[0].attributes.partitioned, true);
    assert.equal(context.anubis_mappings.at(-1).direction, 'upstream-to-client');
    assert.deepEqual(mappingEvents.map(event => event.direction), ['client-to-upstream', 'upstream-to-client']);
    assert.equal(cookieEvents.length, 2);
    assert.doesNotMatch(JSON.stringify(cookieEvents), /issued-by-upstream|proof/);

    const authCookie = authSetCookie.split(';', 1)[0];
    const ordinary = await request(clientPort, '/gallery', { cookie: `${mirrorSid}; ${authCookie}` });
    assert.equal(ordinary.status, 200);
    assert.equal(ordinary.body, 'authorized application response');
    assert.equal(observedNormalCookie, authCookie);
    assert.doesNotMatch(observedNormalCookie, /mirror_sid/);
    assert.equal(context.anubis_version, '1.28.2');
    assert.ok(context.flow_id);

    const otherSession = await request(clientPort, '/gallery');
    const otherSid = otherSession.headers['set-cookie'].find(value => value.startsWith('mirror_sid='))?.split(';', 1)[0];
    assert.ok(otherSid);
    const leakedCookieAttempt = await request(clientPort, '/gallery', { cookie: `${otherSid}; ${authCookie}` });
    assert.equal(leakedCookieAttempt.status, 403);
    assert.equal(observedNormalCookie, '');
  } finally {
    client.closeAllConnections();
    upstream.closeAllConnections();
    await close(client);
    await close(upstream);
  }
});

test('Anubis bridge can connect to a local fixture while preserving a fixed logical upstream origin', async () => {
  const logicalOrigin = 'https://serve.495648.xyz';
  let observedHost;
  let observedRedirect;
  let observedPassUrl;
  const challengeHtml = '<script id="anubis_version" type="application/json">"v1.28.2"</script>';
  const upstream = http.createServer((req, res) => {
    observedHost = req.headers.host;
    if (req.url === '/') return res.writeHead(403, { 'content-type': 'text/html' }).end(challengeHtml);
    observedPassUrl = req.url;
    const incoming = new URL(req.url, 'http://local-fixture');
    observedRedirect = incoming.searchParams.get('redir');
    res.writeHead(302, { location: `${logicalOrigin}/after-challenge` }).end();
  });
  const upstreamPort = await listen(upstream);
  const engine = new ProxyEngine({ sessionManager: new SessionManager({ secure: false }) });
  const route = {
    name: 'local-anubis-logical-origin',
    target: `http://127.0.0.1:${upstreamPort}`,
    upstreamHost: 'serve.495648.xyz',
    publicOrigin: '',
    anubisBridge: {
      enabled: true,
      supportedVersion: '1.28.2',
      upstreamOrigin: logicalOrigin,
    },
  };
  let gateway;
  const client = http.createServer(async (req, res) => gateway.handle(req, res));
  const clientPort = await listen(client);
  route.publicOrigin = `http://127.0.0.1:${clientPort}`;
  gateway = new ClientGateway({ upstreamGateway: new UpstreamGateway({ engine }), publicOrigin: route.publicOrigin, route });
  try {
    const challenge = await request(clientPort, '/', { accept: 'text/html' });
    assert.equal(challenge.status, 403);
    const proxySession = challenge.headers['set-cookie'].find((cookie) => cookie.startsWith('mirror_sid='))?.split(';', 1)[0];
    assert.ok(proxySession);
    const pass = await request(clientPort, `/.within.website/x/cmd/anubis/api/pass-challenge?redir=${encodeURIComponent(`${route.publicOrigin}/original`)}`, { cookie: proxySession });
    assert.equal(observedHost, 'serve.495648.xyz');
    assert.equal(observedRedirect, `${logicalOrigin}/original`, observedPassUrl);
    assert.equal(pass.status, 302);
    assert.equal(pass.headers.location, `${route.publicOrigin}/after-challenge`);
  } finally {
    client.closeAllConnections();
    upstream.closeAllConnections();
    await close(client);
    await close(upstream);
  }
});

test('unknown Anubis version is forwarded untouched but cannot activate PassChallenge mapping', async () => {
  const challengeHtml = '<script id="anubis_version" type="application/json">"9.9.9"</script>';
  let passRequests = 0;
  const upstream = http.createServer((req, res) => {
    if (req.url === '/') return res.writeHead(403, { 'content-type': 'text/html' }).end(challengeHtml);
    passRequests++;
    res.writeHead(200).end();
  });
  const upstreamPort = await listen(upstream);
  const engine = new ProxyEngine({ sessionManager: new SessionManager({ secure: false }) });
  const route = { name: 'unknown-anubis', target: `http://127.0.0.1:${upstreamPort}`, publicOrigin: '', anubisBridge: { enabled: true, supportedVersion: '1.28.2' } };
  let gateway;
  const client = http.createServer(async (req, res) => gateway.handle(req, res));
  const port = await listen(client);
  route.publicOrigin = `http://127.0.0.1:${port}`;
  gateway = new ClientGateway({ upstreamGateway: new UpstreamGateway({ engine }), publicOrigin: route.publicOrigin, route });
  try {
    assert.equal((await request(port, '/', { accept: 'text/html' })).body, challengeHtml);
    const result = await request(port, `/.within.website/x/cmd/anubis/api/pass-challenge?redir=${encodeURIComponent(`${route.publicOrigin}/`)}`);
    assert.equal(result.status, 502);
    assert.equal(result.headers['x-request-id'] !== undefined, true);
    assert.equal(passRequests, 0);
  } finally {
    client.closeAllConnections();
    upstream.closeAllConnections();
    await close(client);
    await close(upstream);
  }
});
