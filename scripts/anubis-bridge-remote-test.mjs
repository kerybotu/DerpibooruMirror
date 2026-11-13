import crypto from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { ClientGateway, ProxyEngine, SessionManager, UpstreamGateway } from '../src/index.mjs';

const PREFIX = '/anubis-bridge-test';
const PASS_PATH = `${PREFIX}/.within.website/x/cmd/anubis/api/pass-challenge`;
const NON_PASS_PATH = `${PREFIX}/.within.website/x/cmd/anubis/api/not-pass-challenge`;
const DEFAULT_CASES = [
  'R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R09', 'R10',
  'L01', 'L02', 'L03', 'L04', 'L05', 'L06', 'L07', 'L08', 'C01', 'C02',
];

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help') return { help: true };
    if (!['--origin', '--proxy-entry', '--cases', '--case'].includes(arg)) throw new Error(`Unknown option ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    values.set(arg, value);
  }
  const origin = new URL(values.get('--origin') || process.env.REMOTE_TEST_ORIGIN || '');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
  if ((origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback)) || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error('--origin must be an HTTPS origin or a loopback HTTP origin without path, query, or credentials');
  }
  const entry = new URL(values.get('--proxy-entry') || 'http://127.0.0.1:0');
  if (entry.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(entry.hostname) || entry.pathname !== '/' || entry.search || entry.hash) {
    throw new Error('--proxy-entry must be a loopback HTTP origin');
  }
  const cases = (values.get('--cases') || values.get('--case') || process.env.REMOTE_TEST_CASES || DEFAULT_CASES.join(','))
    .split(',').map((item) => item.trim()).filter(Boolean);
  if (!cases.length || cases.some((item) => !DEFAULT_CASES.includes(item))) throw new Error('Unknown or empty test case selection');
  return { origin: origin.origin, entry, cases: [...new Set(cases)] };
}

function request(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, headers, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.once('error', reject);
    req.end();
  });
}

function makePath(path, query) {
  const params = new URLSearchParams(query);
  return `${path}?${params}`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runRemoteTests({ origin, entry, cases, token }) {
  const contexts = new Map();
  const sessions = new SessionManager({ secure: false });
  const engine = new ProxyEngine({ sessionManager: sessions });
  const route = {
    name: 'remote-anubis-fixture',
    target: origin,
    publicOrigin: '',
    preservePaths: [`${PREFIX}/`],
    passthroughPaths: [],
    anubisBridge: { enabled: true, supportedVersion: '1.28.2', cookiePrefix: 'proxy-lab', basePrefix: PREFIX },
  };
  let gateway;
  const server = http.createServer((req, res) => {
    const correlationId = req.headers['x-request-id'];
    gateway.handle(req, res).then((result) => {
      if (correlationId) contexts.set(correlationId, result.context);
    }).catch((error) => {
      if (!res.headersSent) { res.writeHead(500); res.end('local test gateway failure'); }
      else res.destroy(error);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(entry.port) || 0, entry.hostname.replace(/^\[|\]$/g, ''), resolve);
  });
  const address = server.address();
  const clientOrigin = `http://${entry.hostname.replace(/^\[|\]$/g, '')}:${address.port}`;
  route.publicOrigin = clientOrigin;
  gateway = new ClientGateway({ upstreamGateway: new UpstreamGateway({ engine }), publicOrigin: clientOrigin, route });
  const results = [];
  const diagnostics = [];
  engine.on('error-classified', (event) => diagnostics.push({ category: event.category, code: event.code }));

  async function send(path, testSession, requestId, cookie = '') {
    return request(address.port, path, {
      'x-request-id': requestId,
      'x-test-session': testSession,
      'x-test-case': new URL(`http://localhost${path}`).searchParams.get('case') || '',
      'x-proxy-lab-token': token,
      ...(cookie ? { cookie } : {}),
    });
  }

  async function remoteRecord(testSession, caseId, requestId) {
    const query = new URLSearchParams({ case: caseId, request_id: requestId });
    const response = await fetch(`${origin}${PREFIX}/__records?${query}`, {
      headers: {
        'x-proxy-lab-token': token,
        'x-test-session': testSession,
        'x-request-id': crypto.randomUUID(),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Remote record query failed with HTTP ${response.status}`);
    const payload = await response.json();
    return payload.records.find((record) => record.request_id === requestId) || null;
  }

  async function challenge(caseId, sessionId, challengeRequestId) {
    const response = await send(makePath(`${PREFIX}/`, { case: caseId }), sessionId, challengeRequestId);
    assert(response.status === 403, `${caseId}: fixture Challenge returned HTTP ${response.status}`);
    const setCookies = response.headers['set-cookie'] || [];
    const mirror = setCookies.find((cookie) => cookie.startsWith('mirror_sid='))?.split(';', 1)[0];
    const verification = setCookies.find((cookie) => cookie.startsWith('proxy-lab-cookie-verification='))?.split(';', 1)[0];
    assert(mirror && verification, `${caseId}: expected isolated mirror and fixture verification cookies`);
    assert(!setCookies.some((cookie) => /domain=/i.test(cookie)), `${caseId}: fixture Anubis cookie must be host-only at client`);
    const context = contexts.get(challengeRequestId);
    assert(context?.anubis_version === (caseId === 'R08' ? '9.9.9' : '1.28.2'), `${caseId}: challenge version was not recorded`);
    assert(context.cookie_processing_summary.stored === 0, `${caseId}: Anubis test cookie entered the ordinary CookieJar`);
    return { mirror, verification, cookie: `${mirror}; ${verification}` };
  }

  async function runCase(caseId) {
    const testSession = crypto.randomUUID();
    const challengeId = crypto.randomUUID();
    let jar = null;
    if (!['R09', 'R10', 'L08'].includes(caseId)) jar = await challenge(caseId, testSession, challengeId);
    if (caseId === 'R10') {
      const requestId = crypto.randomUUID();
      const inputRedir = `${clientOrigin}${PREFIX}/final?case=R10`;
      const response = await send(makePath(`${PREFIX}/business`, { case: caseId, redir: inputRedir }), testSession, requestId);
      const record = await remoteRecord(testSession, caseId, requestId);
      assert(response.status === 200, 'R10: ordinary business request did not remain HTTP 200');
      assert(record?.redir === inputRedir, 'R10: ordinary business redir was changed');
      return 'ordinary request passed unchanged';
    }
    if (caseId === 'R09' || caseId === 'L08') {
      const requestId = crypto.randomUUID();
      const redir = `${clientOrigin}${PREFIX}/final?case=${caseId}`;
      const response = await send(makePath(NON_PASS_PATH, { case: caseId, redir }), testSession, requestId);
      const record = await remoteRecord(testSession, caseId, requestId);
      assert(record?.redir === redir, `${caseId}: non-PassChallenge redir was unexpectedly rewritten`);
      if (caseId === 'L08') {
        assert(response.status === 302, 'L08: expected original non-PassChallenge redirect status');
        assert(response.headers.location === `${origin}${PREFIX}/final?case=L08`, 'L08: non-PassChallenge Location was incorrectly mapped');
      }
      return 'non-PassChallenge request stayed outside special mapping';
    }

    let redir;
    if (caseId === 'R04') redir = 'https://unexpected.invalid/anubis-bridge-test/final';
    else if (caseId === 'R05') redir = `${clientOrigin.replace(/:\d+$/, ':8443')}${PREFIX}/final`;
    else if (caseId === 'R06') redir = `ftp://${new URL(clientOrigin).host}${PREFIX}/final`;
    else if (caseId === 'R07') redir = `${clientOrigin}${PREFIX}/path%252F%252Funexpected.invalid`;
    else if (caseId === 'R02') redir = `${clientOrigin}${PREFIX}/final?space=a%20b&plus=a%2Bb`;
    else redir = `${clientOrigin}${PREFIX}/final?case=${caseId}`;

    const requestId = crypto.randomUUID();
    const path = makePath(PASS_PATH, {
      case: caseId,
      id: 'opaque-fixture-id',
      response: 'fixture-proof-value',
      nonce: '17',
      redir,
      elapsedTime: '42',
    });
    const response = await send(path, testSession, requestId, jar.cookie);
    const context = contexts.get(requestId);
    const expectedValid = !['R04', 'R05', 'R06', 'R07', 'R08'].includes(caseId);
    if (!expectedValid) {
      assert(response.status === 502, `${caseId}: malformed mapping should return HTTP 502, got ${response.status}`);
      assert(!response.headers.location, `${caseId}: rejected mapping unexpectedly returned Location`);
      assert(context?.error_category === 'anubis-bridge-rejected', `${caseId}: RequestContext did not retain bridge rejection`);
      assert(!(await remoteRecord(testSession, caseId, requestId)), `${caseId}: rejected request reached remote fixture`);
      return 'invalid input rejected before upstream';
    }

    const record = await remoteRecord(testSession, caseId, requestId);
    assert(record, `${caseId}: remote fixture did not record the proxied request`);
    const expectedUpstreamRedir = redir.replace(clientOrigin, origin);
    assert(record.redir === expectedUpstreamRedir, `${caseId}: remote received unexpected redir (${record.redir})`);
    assert(record.matched_preset === true, `${caseId}: remote fixture did not match its fixed preset`);

    if (caseId === 'L02') assert(response.status === 200 && !response.headers.location, 'L02: ordinary HTTP 200 was changed');
    else if (caseId === 'L03') assert(response.status === 400 && !response.headers.location, 'L03: upstream HTTP 400 was treated as success');
    else if (['L04', 'L05', 'L06', 'L07'].includes(caseId)) {
      assert(response.status === 502 && !response.headers.location, `${caseId}: abnormal upstream Location was not rejected`);
      assert(context?.error_category === 'anubis-bridge-rejected', `${caseId}: abnormal Location lacked bridge rejection diagnostics`);
    } else {
      assert(response.status === 302, `${caseId}: expected HTTP 302, got ${response.status}`);
      assert(response.headers.location === `${clientOrigin}${PREFIX}/final?case=${caseId}`, `${caseId}: Location did not map exactly back to C`);
    }
    return `remote redir=${record.redir}; client Location=${response.headers.location || '(none)'}`;
  }

  async function runCombined() {
    const caseId = 'C01';
    const testSession = crypto.randomUUID();
    const challengeId = crypto.randomUUID();
    const cookies = await challenge(caseId, testSession, challengeId);
    const passId = crypto.randomUUID();
    const redir = `${clientOrigin}${PREFIX}/final?case=C01`;
    const passPath = makePath(PASS_PATH, { case: caseId, id: 'opaque-fixture-id', response: 'fixture-proof-value', nonce: '17', redir, elapsedTime: '42' });
    const passed = await send(passPath, testSession, passId, cookies.cookie);
    const passRecord = await remoteRecord(testSession, caseId, passId);
    assert(passRecord?.redir === `${origin}${PREFIX}/final?case=C01`, `C01: remote did not receive fixed U redir (${passRecord?.redir || 'no record'})`);
    assert(passed.status === 302, `C01: expected successful fixture 302, got ${passed.status}`);
    assert(passed.headers.location === redir, 'C01: mapped Location did not return to exact C target');
    const authCookie = (passed.headers['set-cookie'] || []).find((cookie) => cookie.startsWith('proxy-lab-auth-deadbeef='));
    assert(authCookie && !/domain=/i.test(authCookie), 'C01: simulated auth cookie was not rewritten to client host-only scope');
    assert(!JSON.stringify(contexts.get(passId)?.cookie_processing_summary).includes('fixture-auth-value'), 'C01: context leaked a cookie value');

    const businessId = crypto.randomUUID();
    const cookiePair = authCookie.split(';', 1)[0];
    const business = await send(makePath(`${PREFIX}/business`, { case: caseId }), testSession, businessId, `${cookies.mirror}; ${cookiePair}`);
    const businessRecord = await remoteRecord(testSession, caseId, businessId);
    assert(business.status === 200, 'C01: follow-up request did not authenticate with the fixture cookie');
    assert(businessRecord?.cookie_names.includes('proxy-lab-auth-deadbeef'), 'C01: follow-up browser cookie did not reach upstream');
    assert(!businessRecord.cookie_names.includes('mirror_sid'), 'C01: proxy session cookie leaked upstream');

    const otherSession = crypto.randomUUID();
    const otherChallengeId = crypto.randomUUID();
    const otherCookies = await challenge('C02', otherSession, otherChallengeId);
    const isolatedId = crypto.randomUUID();
    const isolated = await send(makePath(`${PREFIX}/business`, { case: 'C02' }), otherSession, isolatedId, `${otherCookies.mirror}; ${cookiePair}`);
    const isolatedRecord = await remoteRecord(otherSession, 'C02', isolatedId);
    assert(isolated.status === 403, 'C02: another session reused the first session auth cookie');
    assert(!isolatedRecord?.cookie_names.includes('proxy-lab-auth-deadbeef'), 'C02: another session leaked the first auth cookie upstream');
    assert(!JSON.stringify(diagnostics).includes('fixture-auth-value'), 'Proxy diagnostics leaked a fixture cookie value');
    return `redirs and Locations verified; same-session auth succeeded; cross-session reuse rejected; ${testSession.slice(0, 8)}/${otherSession.slice(0, 8)}`;
  }

  try {
    for (const caseId of cases) {
      try {
        const detail = caseId === 'L01'
          ? await runCombined()
          : await runCase(caseId);
        results.push({ caseId, passed: true, detail });
      } catch (error) {
        results.push({ caseId, passed: false, detail: String(error?.message || 'test failed').slice(0, 180) });
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: REMOTE_TEST_TOKEN=<secret> node scripts/anubis-bridge-remote-test.mjs --origin https://host [--proxy-entry http://127.0.0.1:0] [--cases R01,R02,...]\n');
    return;
  }
  const token = process.env.REMOTE_TEST_TOKEN;
  if (!token || token.length < 32) throw new Error('REMOTE_TEST_TOKEN must contain at least 32 characters');
  const results = await runRemoteTests({ ...options, token });
  for (const result of results) process.stdout.write(`${result.passed ? 'PASS' : 'FAIL'} ${result.caseId}: ${result.detail}\n`);
  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  process.stdout.write(`RESULT ${passed}/${results.length} passed, ${failed} failed\n`);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); }
  catch (error) {
    process.stderr.write(`ERROR ${String(error?.message || 'remote bridge test failed').slice(0, 240)}\n`);
    process.exitCode = 2;
  }
}
