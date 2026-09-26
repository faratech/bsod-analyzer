import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyQuotaFailure, shouldRefund, refundCapFor } from '../server/quotaPolicy.js';
import {
  createProviderQuotaStore,
  createSessionQuotaStore,
  settleProviderTokenReservation
} from '../server/quotaStore.js';

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

const WINDOW = 3600;

test('reserve admits until the request cap, then rejects with a reason', () => {
  const quota = createSessionQuotaStore();
  const args = { requestCost: 1, tokenCost: 10, requestLimit: 3, tokenLimit: 10_000, windowSeconds: WINDOW };
  for (let i = 0; i < 3; i++) {
    assert.equal(quota.reserve('k', args).allowed, true);
  }
  const fourth = quota.reserve('k', args);
  assert.equal(fourth.allowed, false);
  assert.equal(fourth.reason, 'requests');
});

test('reserve checks the token cap before moving either counter', () => {
  const quota = createSessionQuotaStore();
  const args = { requestCost: 1, tokenCost: 600, requestLimit: 100, tokenLimit: 1000, windowSeconds: WINDOW };
  assert.equal(quota.reserve('k', args).allowed, true);
  const second = quota.reserve('k', args);
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'tokens');
  assert.equal(second.requests, 1); // the rejected request was not counted
});

test('a refund releases the reservation but the cap bounds refund farming', () => {
  const quota = createSessionQuotaStore();
  const args = { requestCost: 1, tokenCost: 10, requestLimit: 2, tokenLimit: 10_000, windowSeconds: WINDOW };

  assert.equal(quota.reserve('k', args).allowed, true);
  assert.equal(quota.refund('k', { requestCost: 1, tokenCost: 10, refundCap: 1 }).refunded, true);

  assert.equal(quota.reserve('k', args).allowed, true);
  assert.equal(quota.reserve('k', args).allowed, true);
  assert.equal(quota.refund('k', { requestCost: 1, tokenCost: 10, refundCap: 1 }).refunded, false);
});

test('commit adjusts the token counter by the provider-reported delta', () => {
  const quota = createSessionQuotaStore();
  const args = { requestCost: 1, tokenCost: 500, requestLimit: 100, tokenLimit: 1000, windowSeconds: WINDOW };
  assert.equal(quota.reserve('k', args).allowed, true);
  // Provider reports 200 input tokens instead of the 500 reserved: -300.
  quota.commit('k', { tokenDelta: -300 });
  // 200 consumed; a further 700 fits, 900 does not.
  assert.equal(quota.reserve('k', { ...args, tokenCost: 700 }).allowed, true);
  assert.equal(quota.reserve('k', { ...args, tokenCost: 900 }).allowed, false);
});

test('session windows reset and expired entries are pruned', () => {
  const quota = createSessionQuotaStore();
  const now = Date.now();
  const args = { requestCost: 1, tokenCost: 1, requestLimit: 1, tokenLimit: 10, windowSeconds: 60, now };
  assert.equal(quota.reserve('k', args).allowed, true);
  assert.equal(quota.reserve('k', args).allowed, false);
  // A refund after the window rolled over must not touch the new window.
  assert.equal(quota.refund('k', { tokenCost: 1, refundCap: 5, now: now + 61_000 }).refunded, false);
  assert.equal(quota.reserve('k', { ...args, now: now + 61_000 }).allowed, true);

  quota.prune(now + 200_000);
  assert.equal(quota.size(), 0);
});

const PROVIDER_LIMITS = { dailyInputLimit: 1000, dailyOutputLimit: 1000, hourlyInputLimit: 400, hourlyOutputLimit: 400 };

test('provider budgets keep separate day and hour buckets', () => {
  const quota = createProviderQuotaStore();
  const t0 = Date.UTC(2026, 8, 26, 10, 30);
  const reserve = (now, cost = 300) => quota.reserve('p', { ...PROVIDER_LIMITS, inputCost: cost, outputCost: 0, now });

  assert.equal(reserve(t0).allowed, true);
  assert.equal(reserve(t0).reason, 'hourly'); // 600 > 400 this hour
  // Next hour: the hour bucket is fresh but the day still counts the first 300.
  const t1 = t0 + 60 * 60 * 1000;
  assert.equal(reserve(t1).allowed, true);
  assert.equal(reserve(t1 + 60 * 60 * 1000).allowed, true);
  assert.equal(reserve(t1 + 2 * 60 * 60 * 1000).reason, 'daily'); // 1200 > 1000 today
  // Next UTC day starts clean.
  assert.equal(reserve(Date.UTC(2026, 8, 27, 0, 5)).allowed, true);
});

test('provider shards give each instance its share of the budget', () => {
  const quota = createProviderQuotaStore({ shards: 2 });
  const now = Date.UTC(2026, 8, 26, 10, 30);
  const args = { ...PROVIDER_LIMITS, inputCost: 150, outputCost: 0, now };
  assert.equal(quota.reserve('p', args).allowed, true);
  assert.equal(quota.reserve('p', args).reason, 'hourly'); // share = 200/hour
});

test('adjust releases tokens and the exhaustion latch lasts until the window ends', () => {
  const quota = createProviderQuotaStore();
  const now = Date.UTC(2026, 8, 26, 10, 30);
  const reservation = quota.reserve('p', { ...PROVIDER_LIMITS, inputCost: 400, outputCost: 0, now });
  assert.equal(reservation.allowed, true);
  quota.adjust(reservation, { inputDelta: -400 });
  assert.equal(quota.reserve('p', { ...PROVIDER_LIMITS, inputCost: 400, outputCost: 0, now }).allowed, true);

  quota.markExhausted('p', 'hour', now);
  assert.equal(quota.isExhausted('p', now), true);
  assert.equal(quota.reserve('p', { ...PROVIDER_LIMITS, inputCost: 1, outputCost: 0, now }).reason, 'exhausted');
  assert.equal(quota.isExhausted('p', Date.UTC(2026, 8, 26, 11, 0)), false);

  quota.markExhausted('p', 'day', now);
  assert.equal(quota.isExhausted('p', Date.UTC(2026, 8, 26, 23, 59)), true);
  assert.equal(quota.isExhausted('p', Date.UTC(2026, 8, 27, 0, 0)), false);
});

test('provider settlement releases only provider-reported unused tokens', () => {
  const reservation = { allowed: true, reservedInput: 500, reservedOutput: 100 };
  assert.deepEqual(
    settleProviderTokenReservation(reservation, { inputTokens: 300, outputTokens: 40 }),
    { actualInput: 300, actualOutput: 40, inputDelta: -200, outputDelta: -60, usageEstimated: false }
  );
  assert.deepEqual(
    settleProviderTokenReservation(reservation, {}),
    { actualInput: 500, actualOutput: 100, inputDelta: 0, outputDelta: 0, usageEstimated: true }
  );
});
