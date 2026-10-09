import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProviderQuotaStore,
  providerBackoffFor,
  settleFailedProviderReservation
} from '../server/quotaStore.js';

// Issue #138: a failed provider call releases its local budget only when the
// provider never ran it, and only explicit quota responses latch the route.
const LIMITS = { dailyInputLimit: 10_000, dailyOutputLimit: 10_000, hourlyInputLimit: 10_000, hourlyOutputLimit: 10_000 };
const NOW = Date.UTC(2026, 9, 9, 12, 30);

function reserved(store) {
  const reservation = store.reserve('experiential-luna', { inputCost: 1000, outputCost: 2000, now: NOW, ...LIMITS });
  assert.equal(reservation.allowed, true);
  return reservation;
}

// The store exposes no counters: find the input already counted as the
// smallest `used` for which the remaining 10_000 - used still fits.
function usedInput(store) {
  for (let used = 0; used <= 10_000; used += 100) {
    const fits = store.reserve('experiential-luna', { inputCost: 10_000 - used, outputCost: 0, now: NOW, ...LIMITS });
    if (fits.allowed) {
      store.adjust(fits, { inputDelta: -(10_000 - used) });
      return used;
    }
  }
  return null;
}

test('only a request the provider never ran releases its reservation', () => {
  for (const [error, expectedInput] of [
    [{ notProcessed: true }, 0],
    [{ code: 'AI_TIMEOUT' }, 1000],
    [{ code: 'INVALID_AI_RESPONSE' }, 1000],
    [{ code: 'INVALID_AI_RESPONSE', usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 256 } }, 1500]
  ]) {
    const store = createProviderQuotaStore();
    const reservation = reserved(store);
    store.adjust(reservation, settleFailedProviderReservation(reservation, error));
    assert.equal(usedInput(store), expectedInput, JSON.stringify(error));
  }
  assert.equal(settleFailedProviderReservation({ allowed: false }, { notProcessed: true }), null);
});

test('only explicit quota responses latch; rate limits pause briefly', () => {
  assert.deepEqual(providerBackoffFor({ code: 'AI_QUOTA_EXHAUSTED' }), { latch: 'hour' });
  assert.deepEqual(providerBackoffFor({ code: 'AI_DAILY_QUOTA_EXHAUSTED' }), { latch: 'day' });
  assert.deepEqual(providerBackoffFor({ code: 'AI_AUTH_FAILED' }), { latch: 'day' });
  assert.deepEqual(providerBackoffFor({ code: 'AI_RATE_LIMITED', retryAfterMs: 7000 }), { pauseMs: 7000 });
  assert.deepEqual(providerBackoffFor({ code: 'AI_RATE_LIMITED' }), { pauseMs: 30_000 });
  assert.deepEqual(providerBackoffFor({ code: 'AI_RATE_LIMITED', retryAfterMs: 3_600_000 }), { pauseMs: 300_000 });
  assert.equal(providerBackoffFor({ code: 'AI_UPSTREAM_ERROR' }), null);

  const store = createProviderQuotaStore();
  store.pause('experiential-luna', 30_000, NOW);
  assert.equal(store.isExhausted('experiential-luna', NOW + 29_000), true);
  assert.equal(store.isExhausted('experiential-luna', NOW + 31_000), false, 'a pause ends long before the hour');
});
