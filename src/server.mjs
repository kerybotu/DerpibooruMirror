import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ClientGateway, UpstreamGateway, ProxyEngine, SessionManager, RoutePolicy } from './index.mjs';

const DEFAULTS = Object.freeze({
  server: { host: '127.0.0.1', port: 3000, secure: false },
  upstream: { origin: 'https://derpibooru.org', host: 'derpibooru.org', timeout_ms: 30000, tls_verify: true },
  client: { origin: 'http://127.0.0.1:3000' },
  anubis: { enabled: true, supported_version: '1.27.0', cookie_prefix: 'techaro.lol-anubis' },
});

function mergeConfig(input = {}) {
  const config = {
    server: { ...DEFAULTS.server, ...(input.server || {}) },
    upstream: { ...DEFAULTS.upstream, ...(input.upstream || {}) },
    client: { ...DEFAULTS.client, ...(input.client || {}) },
    anubis: { ...DEFAULTS.anubis, ...(input.anubis || {}) },
  };
  if (config.upstream.origin !== 'https://derpibooru.org' && !process.env.ALLOW_CUSTOM_UPSTREAM) {
    throw new Error('Custom upstream requires ALLOW_CUSTOM_UPSTREAM=1');
  }
  if (config.upstream.tls_verify !== true) throw new Error('upstream.tls_verify must remain true');
  if (!Number.isInteger(config.server.port) || config.server.port < 1 || config.server.port > 65535) throw new Error('Invalid server.port');
  return config;
}

export function loadConfig(path = process.env.MIRROR_CONFIG || null) {
  const file = path ? JSON.parse(fs.readFileSync(path, 'utf8')) : {};
  return mergeConfig(file);
}

export function createServer(config = loadConfig()) {
  const route = new RoutePolicy({ derpibooru: {
    name: 'derpibooru', target: config.upstream.origin, upstreamHost: config.upstream.host,
    publicOrigin: config.client.origin, preservePaths: ['/.within.website/', '/cdn-cgi/challenge-platform/'],
    passthroughPaths: ['/.within.website/', '/cdn-cgi/challenge-platform/'],
    anubisBridge: config.anubis.enabled ? { enabled: true, supportedVersion: config.anubis.supported_version, cookiePrefix: config.anubis.cookie_prefix } : null,
  } }).get('derpibooru');
  const engine = new ProxyEngine({ sessionManager: new SessionManager({ secure: config.client.origin.startsWith('https:') }), timeoutMs: config.upstream.timeout_ms, proxyTimeoutMs: config.upstream.timeout_ms });
  const gateway = new ClientGateway({ upstreamGateway: new UpstreamGateway({ engine }), publicOrigin: config.client.origin, route });
  const handler = async (req, res) => {
    if (req.headers.host !== new URL(config.client.origin).host) { res.writeHead(421); res.end(); return; }
    delete req.headers['x-forwarded-for']; delete req.headers['x-real-ip']; delete req.headers.forwarded;
    try { await gateway.handle(req, res); } catch { if (!res.headersSent) { res.writeHead(502, { 'cache-control': 'no-store' }); res.end('Proxy unavailable'); } }
  };
  const server = config.server.secure ? https.createServer({ key: fs.readFileSync(config.server.key), cert: fs.readFileSync(config.server.cert) }, handler) : http.createServer(handler);
  return { server, engine, route, config };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const app = createServer();
  process.stdout.write('Privacy notice: ordinary upstream cookies are held only in per-session, per-origin memory for forwarding (never persisted to disk); Anubis cookie values are primarily browser-managed. Cookie values, authentication credentials, tokens, authorization headers, and other sensitive credentials are not written to diagnostics or console output. See README.md.\n');
  app.server.listen(app.config.server.port, app.config.server.host, () => process.stdout.write(`Derpibooru proxy listening on ${app.config.client.origin}\n`));
}
