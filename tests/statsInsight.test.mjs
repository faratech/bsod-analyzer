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
  harness.tick(31 * 60 * 1000); // past the failure cool-down (#290)
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

// Issue #290: a failed round must not be retried on every request.
test('a failed round cools down instead of walking every model on each request (#290)', async () => {
  const calls = [];
  let clock = Date.UTC(2026, 9, 30, 12);
  const service = createStatsInsightService({
    isEnabled: () => true,
    getSnapshot: async () => SNAPSHOT,
    now: () => clock,
    provider: async (_request, options) => {
      calls.push(options.model);
      return { text: '' };
    },
    apiKey: 'k',
    models: ['a:free', 'b:free', 'c:free', 'd:free', 'e:free']
  });
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    for (let i = 0; i < 10; i++) {
      const result = await service.getInsight();
      assert.equal(result.available, false);
      clock += 60 * 1000;
    }
    assert.equal(calls.length, 5, 'one walk of the model list within the cool-down');

    clock += 30 * 60 * 1000; // well past the cool-down
    await service.getInsight();
    assert.equal(calls.length, 10, 'one more walk once the cool-down has passed');
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
});

test('a failed regeneration keeps serving the stale insight during the cool-down (#290)', async () => {
  let clock = Date.UTC(2026, 9, 30, 12);
  let calls = 0;
  let fail = false;
  const service = createStatsInsightService({
    isEnabled: () => true,
    getSnapshot: async () => SNAPSHOT,
    now: () => clock,
    provider: async () => {
      calls += 1;
      if (fail) throw new Error('upstream down');
      return JSON.stringify({ insight: 'First.' });
    },
    apiKey: 'k',
    models: ['only:free'],
    ttlSeconds: 3600
  });
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    assert.equal((await service.getInsight()).text, 'First.');
    fail = true;
    clock += 2 * 3600 * 1000; // past TTL
    for (let i = 0; i < 5; i++) {
      const stale = await service.getInsight();
      assert.equal(stale.available, true);
      assert.equal(stale.stale, true);
      assert.equal(stale.text, 'First.');
      clock += 60 * 1000;
    }
    assert.equal(calls, 2, 'one failed regeneration, then the cool-down holds');
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
});

test('each provider call carries an abort deadline so a hung model cannot hold the slot (#290)', { timeout: 5000 }, async () => {
  const signals = [];
  const service = createStatsInsightService({
    isEnabled: () => true,
    getSnapshot: async () => SNAPSHOT,
    provider: async (_request, options) => {
      signals.push(options.signal);
      if (options.model === 'hung:free') {
        // Never answers on its own; only the deadline ends it.
        await new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
      }
      return JSON.stringify({ insight: 'From the second model.' });
    },
    apiKey: 'k',
    models: ['hung:free', 'ok:free'],
    callTimeoutMs: 50
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await service.getInsight();
    assert.equal(result.available, true);
    assert.equal(result.model, 'ok:free');
    assert.equal(signals.length, 2);
    assert.ok(signals.every(signal => signal instanceof AbortSignal));
  } finally {
    console.warn = originalWarn;
  }
});

// Issue #322: pin the remaining #290 limits.
function quietConsole(t) {
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = () => {};
  console.error = () => {};
  t.after(() => {
    console.warn = originalWarn;
    console.error = originalError;
  });
}

const statusError = status => Object.assign(new Error(`HTTP ${status}`), { status });

test('a key-level failure (401/402/403) stops the model walk after one call (#322)', async t => {
  quietConsole(t);
  for (const status of [401, 402, 403]) {
    const calls = [];
    const service = createStatsInsightService({
      isEnabled: () => true,
      getSnapshot: async () => SNAPSHOT,
      provider: async (_request, options) => {
        calls.push(options.model);
        throw statusError(status);
      },
      apiKey: 'k',
      models: ['a:free', 'b:free', 'c:free']
    });
    assert.equal((await service.getInsight()).available, false);
    assert.deepEqual(calls, ['a:free'], `status ${status}`);
  }

  // Any other failure moves on to the next model.
  const calls = [];
  const service = createStatsInsightService({
    isEnabled: () => true,
    getSnapshot: async () => SNAPSHOT,
    provider: async (_request, options) => {
      calls.push(options.model);
      throw statusError(500);
    },
    apiKey: 'k',
    models: ['a:free', 'b:free', 'c:free']
  });
  await service.getInsight();
  assert.deepEqual(calls, ['a:free', 'b:free', 'c:free']);
});

test('a quota failure (402/429) cools down for an hour, other failures for 20 minutes (#322)', async t => {
  quietConsole(t);
  for (const [status, cooldownMinutes] of [[402, 60], [429, 60], [500, 20]]) {
    let clock = Date.UTC(2026, 9, 30, 12);
    let calls = 0;
    const service = createStatsInsightService({
      isEnabled: () => true,
      getSnapshot: async () => SNAPSHOT,
      now: () => clock,
      provider: async () => {
        calls += 1;
        throw statusError(status);
      },
      apiKey: 'k',
      models: ['only:free']
    });
    await service.getInsight();
    assert.equal(calls, 1);
    clock += (cooldownMinutes - 1) * 60 * 1000;
    await service.getInsight();
    assert.equal(calls, 1, `status ${status}: no new round inside ${cooldownMinutes} minutes`);
    clock += 2 * 60 * 1000;
    await service.getInsight();
    assert.equal(calls, 2, `status ${status}: a new round after ${cooldownMinutes} minutes`);
  }
});

test('the whole round has a deadline, not only each call (#322)', { timeout: 5000 }, async t => {
  quietConsole(t);
  const calls = [];
  const service = createStatsInsightService({
    isEnabled: () => true,
    getSnapshot: async () => SNAPSHOT,
    provider: async (_request, options) => {
      calls.push(options.model);
      // Hangs until a deadline aborts it.
      await new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    },
    apiKey: 'k',
    models: ['a:free', 'b:free', 'c:free'],
    callTimeoutMs: 200,
    roundTimeoutMs: 50
  });
  const result = await service.getInsight();
  assert.equal(result.available, false);
  assert.deepEqual(calls, ['a:free'], 'the expired round starts no further model');
});
