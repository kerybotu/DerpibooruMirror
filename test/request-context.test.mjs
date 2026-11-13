import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestContext, recordError, transitionResponseStage } from '../src/index.mjs';

function context() {
  return createRequestContext({ headers: { host: 'mirror.test' }, url: '/' }, { publicOrigin: 'http://mirror.test' });
}

test('first error remains authoritative while later errors append sanitized events', () => {
  const value = context();
  recordError(value, { category: 'dns-failure', stage: 'upstream-dns', message: 'lookup secret=first-token failed', code: 'ENOTFOUND' });
  recordError(value, { category: 'upstream-timeout', stage: 'upstream-response', message: 'later timeout cookie=session-secret', code: 'ETIMEDOUT' });
  transitionResponseStage(value, 'client-response-complete');

  assert.equal(value.error_category, 'dns-failure');
  assert.equal(value.error_stage, 'upstream-dns');
  assert.match(value.error_message, /secret=\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(value), /first-token|session-secret/);
  assert.equal(value.error_events.length, 2);
  assert.equal(value.error_events[1].category, 'upstream-timeout');
  assert.equal(value.response_processing_stage, 'error');
});

test('error messages are bounded and client abort remains sticky', () => {
  const value = context();
  recordError(value, { category: 'client-aborted', stage: 'client-response', message: `Authorization: Bearer ${'x'.repeat(500)}`, clientAborted: true });
  transitionResponseStage(value, 'client-response-complete');
  assert.equal(value.client_aborted, true);
  assert.equal(value.error_message.length <= 240, true);
  assert.equal(value.response_processing_stage, 'error');
});

test('WebSocket close details retain numeric code and redact secret-like reason text', () => {
  const value = context();
  recordError(value, { category: 'websocket-transport-failure', stage: 'websocket-lifecycle', message: 'WebSocket closed abnormally', details: { closeCode: 1011, closeReason: 'authorization=private' } });
  assert.deepEqual(value.error_events[0].details, { closeCode: 1011, closeReason: 'authorization=[redacted]' });
  assert.doesNotMatch(JSON.stringify(value), /private/);
});
