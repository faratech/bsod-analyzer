import test from 'node:test';
import assert from 'node:assert/strict';

import { createStatsInsightService } from '../server/statsInsight.js';

function createFakeRedis() {
  const store = new Map();
  return {
    async get(k) {
      const entry = store.get(String(k));
      if (!entry || (entry.expiresAt !== null && entry.expiresAt < Date.now())) return null;
      return entry.value;
    },
    async set(k, v, opts = {}) {
      const entry = store.get(String(k));
      const alive = entry && (entry.expiresAt === null || entry.expiresAt > Date.now());
      if (opts.nx && alive) return null;
      store.set(String(k), {
        value: String(v),
        expiresAt: opts.ex ? Date.now() + opts.ex * 1000 : null
      });
      return 'OK';
    },
    async del(k) {
      return store.delete(String(k)) ? 1 : 0;
    },
    _peek(k) {
      return store.get(String(k));
    }
  };
}

const SNAPSHOT = {
  totals: { analyses: 10707 },
  gauges: { today: 130, lastHour: 3 },
  daily: Array.from({ length: 90 }, (_, i) => ({ date: `2026${String(5 + Math.floor(i / 30)).padStart(2, '0')}${String(1 + (i % 28)).padStart(2, '0')}`, count: i })),
  topStopCodes: { items: [{ value: '0x3B', label: 'SYSTEM_SERVICE_EXCEPTION', description: 'A system service crashed.', count: 1008 }], other: 5, total: 1013 },
  topModules: { items: [{ value: 'ntkrnlmp.exe', count: 3747 }], other: 0, total: 3747 },
  osVersions: { items: [{ value: '10.0.26100', count: 9000 }], other: 0, total: 9000 },
  dumpTypes: { items: [{ value: 'kernel', count: 8000 }], other: 0, total: 8000 },
  sources: { items: [{ value: 'windbg', count: 8000 }], other: 0, total: 8000 }
};

function buildService(redis, { providerCalls = [], nowMs = Date.UTC(2026, 7, 23, 12), ttlSeconds = 21600, apiKey = 'test-key', providerImpl } = {}) {
  let clock = nowMs;
  const provider = providerImpl ?? (async () => {
    providerCalls.push(clock);
    return JSON.stringify({ insight: `Synthetic insight #${providerCalls.length}.` });
  });
  const service = createStatsInsightService({
    getClient: () => redis,
    isEnabled: () => true,
    getSnapshot: async () => SNAPSHOT,
    now: () => clock,
    provider,
    apiKey,
    model: 'test/free-model',
    ttlSeconds
  });
  return {
    service,
    tick(ms) { clock += ms; },
    calls: () => providerCalls.length
  };
}

test('generates once then serves the cached narrative', async () => {
  const redis = createFakeRedis();
  const harness = buildService(redis);
  const first = await harness.service.getInsight();
  assert.equal(first.available, true);
  assert.equal(first.cached, false);
  assert.match(first.text, /Synthetic insight #1/);
  assert.equal(first.model, 'test/free-model');

  harness.tick(60_000);
  const second = await harness.service.getInsight();
  assert.equal(second.cached, true);
  assert.equal(second.text, first.text);
  assert.equal(harness.calls(), 1);
});

test('regenerates after TTL and single-flights concurrent misses', async () => {
  const redis = createFakeRedis();
  const harness = buildService(redis, { ttlSeconds: 3600 });
  await harness.service.getInsight();
  harness.tick(2 * 3600 * 1000); // past TTL
  // Simulate a competing holder of the lock: stale text should still serve.
  await redis.set('stats:insight:lock', '1', { ex: 120 });
  const contended = await harness.service.getInsight();
  assert.equal(contended.cached, true);
  assert.equal(contended.stale, true);
  assert.equal(harness.calls(), 1);
  await redis.del('stats:insight:lock');

  const fresh = await harness.service.getInsight();
  assert.equal(fresh.cached, false);
  assert.match(fresh.text, /Synthetic insight #2/);
});

test('provider failure yields unavailable without poisoning the cache', async () => {
  const redis = createFakeRedis();
  const failing = buildService(redis, {
    providerImpl: async () => { throw new Error('upstream down'); }
  });
  const result = await failing.service.getInsight();
  assert.equal(result.available, false);
  assert.equal(await redis.get('stats:insight'), null);
  assert.equal(await redis.get('stats:insight:lock'), null); // lock released
});

test('disabled or key-less deployments report unavailable', async () => {
  const noKey = buildService(createFakeRedis(), { apiKey: '' });
  assert.equal((await noKey.service.getInsight()).available, false);

  const redis = createFakeRedis();
  const disabled = createStatsInsightService({
    getClient: () => redis,
    isEnabled: () => false,
    getSnapshot: async () => SNAPSHOT,
    apiKey: 'k'
  });
  assert.equal((await disabled.getInsight()).available, false);
});
