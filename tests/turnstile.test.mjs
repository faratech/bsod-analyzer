import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTurnstileReplayGuard } from '../server/turnstile.js';

// Models Redis INCRBY semantics: every call is atomic and returns the new count.
function fakeRedisCounter() {
  const counts = new Map();
  const calls = [];
  const increment = async (key, _ttl, delta = 1) => {
    calls.push({ key, delta });
    const next = (counts.get(key) || 0) + delta;
    counts.set(key, next);
    return { count: next };
  };
  return { increment, calls, counts };
}

test('first reservation wins, replays are rejected (issue #72)', async () => {
  const redis = fakeRedisCounter();
  const guard = createTurnstileReplayGuard({ incrementCounter: redis.increment, redisEnabled: () => true });

  const first = await guard.reserve('token-a');
  assert.equal(first.reserved, true);

  const replay = await guard.reserve('token-a');
  assert.equal(replay.duplicate, true);
  assert.ok(!replay.reserved);
});

test('concurrent reservations of the same token yield exactly one winner', async () => {
  const redis = fakeRedisCounter();
  const guard = createTurnstileReplayGuard({ incrementCounter: redis.increment, redisEnabled: () => true });

  const results = await Promise.all([
    guard.reserve('token-b'),
    guard.reserve('token-b'),
    guard.reserve('token-b')
  ]);
  assert.equal(results.filter(r => r.reserved).length, 1);
  assert.equal(results.filter(r => r.duplicate).length, 2);
});

test('an unavailable counter store reports unavailable instead of admitting', async () => {
  const guard = createTurnstileReplayGuard({
    incrementCounter: async () => null,
    redisEnabled: () => true
  });
  const result = await guard.reserve('token-c');
  assert.equal(result.unavailable, true);
  assert.ok(!result.reserved);
});

test('release decrements the reservation so failed verifications can retry', async () => {
  const redis = fakeRedisCounter();
  const guard = createTurnstileReplayGuard({ incrementCounter: redis.increment, redisEnabled: () => true });

  await guard.reserve('token-d');
  await guard.release('token-d');
  assert.deepEqual(redis.calls.at(-1), { key: redis.calls[0].key, delta: -1 });

  // The freed token can be reserved again (idempotency-key retry path).
  const again = await guard.reserve('token-d');
  assert.equal(again.reserved, true);
});

test('different tokens never collide (keys are fingerprinted)', async () => {
  const redis = fakeRedisCounter();
  const guard = createTurnstileReplayGuard({ incrementCounter: redis.increment, redisEnabled: () => true });

  const a = await guard.reserve('token-e');
  const b = await guard.reserve('token-f');
  assert.equal(a.reserved, true);
  assert.equal(b.reserved, true);
  assert.equal(new Set(redis.calls.map(c => c.key)).size, 2);
});

test('without Redis the guard degrades to a bounded in-memory map', async () => {
  const guard = createTurnstileReplayGuard({ redisEnabled: () => false });
  assert.equal((await guard.reserve('token-g')).reserved, true);
  assert.equal((await guard.reserve('token-g')).duplicate, true);

  guard.prune(0, Date.now() + 1);
  assert.equal(guard.memorySize(), 0);
  assert.equal((await guard.reserve('token-g')).reserved, true);
});
