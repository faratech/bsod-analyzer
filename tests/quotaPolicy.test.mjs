import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyQuotaFailure, shouldRefund, refundCapFor } from '../server/quotaPolicy.js';
import { reserveSessionQuota, commitSessionTokens, refundSessionQuota } from '../services/cache.js';

test('quota failures classify into refundable and non-refundable classes', () => {
  assert.equal(classifyQuotaFailure({ code: 'AI_TIMEOUT' }), 'timeout');
  assert.equal(classifyQuotaFailure({ name: 'AbortError', message: 'aborted' }), 'timeout');
  assert.equal(classifyQuotaFailure({ message: 'Request timed out after 30s' }), 'timeout');
  assert.equal(classifyQuotaFailure({ status: 503 }), 'upstream');
  assert.equal(classifyQuotaFailure({ code: 'AI_UPSTREAM_ERROR', retryable: true }), 'upstream');
  assert.equal(classifyQuotaFailure({ code: 'INVALID_AI_RESPONSE' }), 'invalid_response');
  assert.equal(classifyQuotaFailure({ code: 'AI_NOT_CONFIGURED' }), 'config');
  assert.equal(classifyQuotaFailure({ code: 'UNSUPPORTED_AI_MODEL' }), 'config');
  assert.equal(classifyQuotaFailure(new TypeError('cannot read property')), 'unknown');
});

test('refunds apply to upstream/timeout/invalid-response failures only', () => {
  assert.equal(shouldRefund({ code: 'AI_TIMEOUT' }), true);
  assert.equal(shouldRefund({ status: 500 }), true);
  assert.equal(shouldRefund({ code: 'INVALID_AI_RESPONSE' }), true);
  assert.equal(shouldRefund({ code: 'AI_NOT_CONFIGURED' }), false);
  assert.equal(shouldRefund(new TypeError('bug')), false);
});

test('refund cap defaults to half the request allowance, floor of five', () => {
  assert.equal(refundCapFor(50), 25);
  assert.equal(refundCapFor(8), 5);
  assert.equal(refundCapFor(0), 5);
  assert.equal(refundCapFor(50, 3), 3);
  assert.equal(refundCapFor(50, 0), 0);
});

test('QUOTA_REFUND_CAP env overrides the default cap', () => {
  const previous = process.env.QUOTA_REFUND_CAP;
  try {
    process.env.QUOTA_REFUND_CAP = '2';
    assert.equal(refundCapFor(50), 2);
    process.env.QUOTA_REFUND_CAP = 'nope';
    assert.equal(refundCapFor(50), 25);
  } finally {
    if (previous === undefined) delete process.env.QUOTA_REFUND_CAP;
    else process.env.QUOTA_REFUND_CAP = previous;
  }
});

// The in-memory branch is exercised directly (cache disabled on import); it
// shares its semantics with the Redis scripts, which need a live Upstash.
const WINDOW = 3600;

test('reserve admits until the request cap, then rejects with a reason', async () => {
  const key = `test:req-cap:${Math.random()}`;
  for (let i = 0; i < 3; i++) {
    const result = await reserveSessionQuota(key, {
      requestCost: 1, tokenCost: 10, requestLimit: 3, tokenLimit: 10_000, windowSeconds: WINDOW
    });
    assert.equal(result.allowed, true);
  }
  const fourth = await reserveSessionQuota(key, {
    requestCost: 1, tokenCost: 10, requestLimit: 3, tokenLimit: 10_000, windowSeconds: WINDOW
  });
  assert.equal(fourth.allowed, false);
  assert.equal(fourth.reason, 'requests');
});

test('reserve enforces the token cap atomically with the request cap', async () => {
  const key = `test:tok-cap:${Math.random()}`;
  const args = { requestCost: 1, tokenCost: 600, requestLimit: 100, tokenLimit: 1000, windowSeconds: WINDOW };
  assert.equal((await reserveSessionQuota(key, args)).allowed, true);
  const second = await reserveSessionQuota(key, args);
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'tokens');
});

test('a refund releases the reservation but the cap bounds refund farming', async () => {
  const key = `test:refund:${Math.random()}`;
  const args = { requestCost: 1, tokenCost: 10, requestLimit: 2, tokenLimit: 10_000, windowSeconds: WINDOW, refundCap: 1 };

  assert.equal((await reserveSessionQuota(key, args)).allowed, true);
  const first = await refundSessionQuota(key, { requestCost: 1, tokenCost: 10, windowSeconds: WINDOW, refundCap: args.refundCap });
  assert.equal(first.refunded, true);

  assert.equal((await reserveSessionQuota(key, args)).allowed, true);
  assert.equal((await reserveSessionQuota(key, args)).allowed, true);
  const overCap = await refundSessionQuota(key, { requestCost: 1, tokenCost: 10, windowSeconds: WINDOW, refundCap: args.refundCap });
  assert.equal(overCap.refunded, false);
});

test('commit adjusts the token counter by the provider-reported delta', async () => {
  const key = `test:commit:${Math.random()}`;
  const args = { requestCost: 1, tokenCost: 500, requestLimit: 100, tokenLimit: 1000, windowSeconds: WINDOW };
  assert.equal((await reserveSessionQuota(key, args)).allowed, true);
  // Provider reports 200 input tokens instead of the 500 reserved: -300.
  await commitSessionTokens(key, { tokenDelta: -300, windowSeconds: WINDOW });
  // 200 consumed; a further 700 fits, 900 does not.
  assert.equal((await reserveSessionQuota(key, { ...args, tokenCost: 700 })).allowed, true);
  assert.equal((await reserveSessionQuota(key, { ...args, tokenCost: 900 })).allowed, false);
});

test('legacy tracking records seed the first reservation window', async () => {
  const key = `test:legacy:${Math.random()}`;
  const seeded = await reserveSessionQuota(key, {
    requestCost: 1, tokenCost: 0, requestLimit: 3, tokenLimit: 1000, windowSeconds: WINDOW,
    legacy: { requests: 2, tokens: 500 }
  });
  // Legacy usage counts against the new window: only one request remains.
  assert.equal(seeded.allowed, true);
  assert.equal(seeded.requests, 3);
  assert.equal(seeded.tokens, 500);
  const next = await reserveSessionQuota(key, {
    requestCost: 1, tokenCost: 0, requestLimit: 3, tokenLimit: 1000, windowSeconds: WINDOW,
    legacy: { requests: 0, tokens: 0 }
  });
  assert.equal(next.allowed, false);
  assert.equal(next.reason, 'requests');
});

test('the in-memory branch is reachable only with cache disabled and never reports unavailable', async () => {
  // The Redis branch is not exercised here (no live Upstash); the memory
  // fallback must therefore never surface 'unavailable' — the store IS the
  // process, so a 503 would mean a bug in the branch selection itself.
  const result = await reserveSessionQuota(`test:ok:${Math.random()}`, {
    requestCost: 1, tokenCost: 1, requestLimit: 1, tokenLimit: 10, windowSeconds: WINDOW
  });
  assert.equal(result.allowed, true);
  assert.notEqual(result.reason, 'unavailable');
});
