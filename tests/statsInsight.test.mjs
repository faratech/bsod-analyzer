import test from 'node:test';
import assert from 'node:assert/strict';

import { createStatsInsightService } from '../server/statsInsight.js';

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

function buildService({ providerCalls = [], nowMs = Date.UTC(2026, 7, 23, 12), ttlSeconds = 21600, apiKey = 'test-key', providerImpl } = {}) {
  let clock = nowMs;
  const provider = providerImpl ?? (async () => {
    providerCalls.push(clock);
    return JSON.stringify({ insight: `Synthetic insight #${providerCalls.length}.` });
  });
  const service = createStatsInsightService({
    isEnabled: () => true,
    getSnapshot: async () => SNAPSHOT,
    now: () => clock,
    provider,
    apiKey,
    models: ['test/free-model'],
    ttlSeconds
  });
  return {
    service,
    tick(ms) { clock += ms; },
    calls: () => providerCalls.length
  };
}

test('generates once then serves the cached narrative', async () => {
  const harness = buildService();
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

test('regenerates after TTL and serves stale text to concurrent callers', async () => {
  let release;
  let calls = 0;
  const harness = buildService({
    ttlSeconds: 3600,
    providerImpl: async () => {
      calls += 1;
      if (calls === 2) await new Promise(resolve => { release = resolve; });
      return JSON.stringify({ insight: `Synthetic insight #${calls}.` });
    }
  });
  await harness.service.getInsight();
  harness.tick(2 * 3600 * 1000); // past TTL

  const regenerating = harness.service.getInsight();
  await new Promise(resolve => setImmediate(resolve));
  const concurrent = await harness.service.getInsight();
  assert.equal(concurrent.cached, true);
  assert.equal(concurrent.stale, true);
  assert.match(concurrent.text, /#1/);

  release();
  const fresh = await regenerating;
  assert.equal(fresh.cached, false);
  assert.match(fresh.text, /Synthetic insight #2/);
  assert.equal(calls, 2);
});

test('provider failure yields unavailable without poisoning the cache', async () => {
  let fail = true;
  const harness = buildService({
    providerImpl: async () => {
      if (fail) throw new Error('upstream down');
      return JSON.stringify({ insight: 'Recovered.' });
    }
  });
  assert.equal((await harness.service.getInsight()).available, false);
  fail = false;
  const recovered = await harness.service.getInsight();
  assert.equal(recovered.available, true);
  assert.equal(recovered.text, 'Recovered.');
});

test('disabled or key-less deployments report unavailable', async () => {
  const noKey = buildService({ apiKey: '' });
  assert.equal((await noKey.service.getInsight()).available, false);

  const disabled = createStatsInsightService({
    isEnabled: () => false,
    getSnapshot: async () => SNAPSHOT,
    apiKey: 'k'
  });
  assert.equal((await disabled.getInsight()).available, false);
});
