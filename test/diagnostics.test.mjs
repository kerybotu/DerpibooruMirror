import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnosticLogger, sanitizePath } from '../src/diagnostics.mjs';

test('diagnostics redact sensitive query fields and never serialize credentials', () => {
  assert.equal(sanitizePath('/challenge?token=abc&ok=yes&session=secret'), '/challenge?token=[redacted]&ok=yes&session=[redacted]');
  assert.equal(sanitizePath('/.within.website/pass?id=challenge-id&response=proof&nonce=17&redir=https%3A%2F%2Fmirror.test%2Fprivate%3Fsearch%3Dsecret'), '/.within.website/pass?id=[redacted]&response=[redacted]&nonce=[redacted]&redir=[redacted]');
  const lines = [];
  const logger = createDiagnosticLogger(line => lines.push(line));
  logger.request({ requestId: 'r1', method: 'GET', route: 'main', upstreamHost: 'upstream.test', path: '/x?jwt=topsecret' });
  logger.response({ requestId: 'r1', statusCode: 200, upstreamStatus: 200, elapsedMs: 12 });
  logger.error({ requestId: 'r1', category: 'upstream-timeout', code: 'ETIMEDOUT', statusCode: 504 });
  const output = lines.join('\n');
  assert.ok(!output.includes('topsecret'));
  assert.ok(output.includes('upstream-timeout'));
});
