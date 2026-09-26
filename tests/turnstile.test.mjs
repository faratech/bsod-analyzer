import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTurnstileReplayGuard } from '../server/turnstile.js';

test('first reservation wins, replays are rejected (issue #72)', () => {
  const guard = createTurnstileReplayGuard();

  const first = guard.reserve('token-a');
  assert.equal(first.reserved, true);

  const replay = guard.reserve('token-a');
  assert.equal(replay.duplicate, true);
  assert.ok(!replay.reserved);
});

test('concurrent reservations of the same token yield exactly one winner', async () => {
  const guard = createTurnstileReplayGuard();

  const results = await Promise.all([
    Promise.resolve().then(() => guard.reserve('token-b')),
    Promise.resolve().then(() => guard.reserve('token-b')),
    Promise.resolve().then(() => guard.reserve('token-b'))
  ]);
  assert.equal(results.filter(r => r.reserved).length, 1);
  assert.equal(results.filter(r => r.duplicate).length, 2);
});

test('release frees the reservation so a failed verification can retry', () => {
  const guard = createTurnstileReplayGuard();

  guard.reserve('token-d');
  guard.release('token-d');
  assert.equal(guard.reserve('token-d').reserved, true);
});

test('different tokens never collide and raw tokens are not retained', () => {
  const guard = createTurnstileReplayGuard();

  assert.equal(guard.reserve('token-e').reserved, true);
  assert.equal(guard.reserve('token-f').reserved, true);
  assert.equal(guard.size(), 2);
});

test('prune drops reservations older than the window', () => {
  const guard = createTurnstileReplayGuard();
  const now = Date.now();
  guard.reserve('token-old', now - 10 * 60 * 1000);
  guard.reserve('token-new', now);

  guard.prune(5 * 60 * 1000, now);
  assert.equal(guard.size(), 1);
  assert.equal(guard.reserve('token-old', now).reserved, true);
  assert.equal(guard.reserve('token-new', now).duplicate, true);
});
