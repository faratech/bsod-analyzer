import test from 'node:test';
import assert from 'node:assert/strict';
import { windbgFailureLogFields } from '../server/windbgFailureLog.js';

test('upstream HTTP failure keeps code and status beside the bounded message', () => {
  const error = new Error(`WinDBG job submit failed with status 524: ${'x'.repeat(600)}`);
  error.code = 'WINDBG_UPSTREAM_ERROR';
  error.upstreamStatus = 524;

  const fields = windbgFailureLogFields(error);

  assert.equal(fields.code, 'WINDBG_UPSTREAM_ERROR');
  assert.equal(fields.upstreamStatus, 524);
  assert.equal(fields.message.length, 500);
  assert.equal(fields.cause, undefined);
  assert.equal(fields.causeCode, undefined);
});

test('fetch failed keeps the underlying cause that message alone hides', () => {
  // Node/undici shape from the 2026-10-13 incident: a bare TypeError whose
  // cause carries the socket-level reason the alert could not see.
  const cause = new Error('socket hang up');
  cause.code = 'ECONNRESET';
  const error = new TypeError('fetch failed');
  error.cause = cause;

  const fields = windbgFailureLogFields(error);

  assert.equal(fields.message, 'fetch failed');
  assert.equal(fields.cause, 'socket hang up');
  assert.equal(fields.causeCode, 'ECONNRESET');
});

test('timeout keeps its name so an abort is distinguishable from a reset', () => {
  const error = new Error('The operation was aborted due to timeout');
  error.name = 'TimeoutError';

  assert.equal(windbgFailureLogFields(error).name, 'TimeoutError');
});

test('plain and missing errors degrade to a bounded message only', () => {
  assert.deepEqual(windbgFailureLogFields(new Error('boom')), {
    message: 'boom',
    name: undefined,
    code: undefined,
    upstreamStatus: undefined,
    causeCode: undefined,
    cause: undefined
  });
  assert.equal(windbgFailureLogFields(null).message, '');
  assert.equal(windbgFailureLogFields(undefined).message, '');
});

test('string cause is bounded and kept', () => {
  const error = new Error('fetch failed');
  error.cause = 'y'.repeat(300);

  const fields = windbgFailureLogFields(error);

  assert.equal(fields.cause.length, 200);
  assert.equal(fields.causeCode, undefined);
});
