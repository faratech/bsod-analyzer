import test from 'node:test';
import assert from 'node:assert/strict';
import { AIProviderError, generateExperientialContent } from '../services/aiProvider.js';
import { createProviderQuotaStore, settleFailedProviderReservation } from '../server/quotaStore.js';

// Issue #273: once a retried 5xx may have run on the provider, every error the
// call throws afterwards carries that attempt's usage (or counts it as an
// unmetered attempt) and is no longer `notProcessed`, so the reservation is
// settled to what the provider ran instead of being released.
const meteredFiveHundred = () => new Response(JSON.stringify({
  error: { message: 'upstream' },
  usage: { prompt_tokens: 900, completion_tokens: 400, total_tokens: 1300 }
}), { status: 503 });

const refused = () => Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
});

function run(second) {
  let calls = 0;
  return generateExperientialContent({ contents: 'x', config: {} }, {
    apiKey: 'test-key',
    maxRetries: 1,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return meteredFiveHundred();
      return second();
    }
  });
}

const laterFailures = {
  'non-quota 429': () => new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429 }),
  'quota 429': () => new Response(JSON.stringify({ error: { message: 'quota exceeded', code: 'insufficient_quota' } }), { status: 429 }),
  '403': () => new Response(JSON.stringify({ error: { message: 'forbidden' } }), { status: 403 }),
  '400': () => new Response('bad request', { status: 400 }),
  'connect-time ECONNREFUSED': () => { throw refused(); }
};

for (const [name, second] of Object.entries(laterFailures)) {
  test(`a ${name} after a metered retried 5xx keeps that attempt's usage`, async () => {
    let caught;
    await assert.rejects(run(second), error => { caught = error; return error instanceof AIProviderError; });
    assert.equal(caught.notProcessed, false, 'an earlier attempt may have run');
    assert.equal(caught.usageMetadata?.promptTokenCount, 900);
    assert.equal(caught.usageMetadata?.candidatesTokenCount, 400);

    const store = createProviderQuotaStore({ shards: 1 });
    const limits = { dailyInputLimit: 1e7, dailyOutputLimit: 1e7, hourlyInputLimit: 1e7, hourlyOutputLimit: 1e7 };
    const reservation = store.reserve('experiential-luna', { inputCost: 10_000, outputCost: 16_384, ...limits });
    const settlement = settleFailedProviderReservation(reservation, caught);
    assert.equal(settlement.released, false);
    assert.equal(settlement.inputDelta, 900 - 10_000);
    assert.equal(settlement.outputDelta, 400 - 16_384);
  });
}

test('a later failure after an unmetered retried 5xx keeps one estimate per attempt that may have run', async () => {
  let calls = 0;
  let caught;
  await assert.rejects(generateExperientialContent({ contents: 'x', config: {} }, {
    apiKey: 'test-key',
    maxRetries: 2,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls += 1;
      if (calls <= 2) return new Response('upstream', { status: 502 });
      return new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429 });
    }
  }), error => { caught = error; return true; });
  assert.equal(caught.code, 'AI_RATE_LIMITED');
  assert.equal(caught.notProcessed, false);
  assert.equal(caught.unmeteredAttempts, 2);
  const reservation = { allowed: true, reservedInput: 1000, reservedOutput: 2000 };
  const settlement = settleFailedProviderReservation(reservation, caught);
  assert.deepEqual(
    { input: settlement.inputDelta, output: settlement.outputDelta, released: settlement.released },
    { input: 1000, output: 2000, released: false },
    'two attempts may have run: keep two estimates'
  );
});

test('a final 5xx after a metered retried 5xx carries both attempts', async () => {
  let caught;
  await assert.rejects(run(meteredFiveHundred), error => { caught = error; return true; });
  assert.equal(caught.code, 'AI_UPSTREAM_ERROR');
  assert.equal(caught.notProcessed, false);
  assert.equal(caught.usageMetadata?.promptTokenCount, 1800);
  assert.equal(caught.usageMetadata?.candidatesTokenCount, 800);
});

test('a first-attempt refusal is still provably not processed', async () => {
  let caught;
  await assert.rejects(generateExperientialContent({ contents: 'x', config: {} }, {
    apiKey: 'test-key',
    maxRetries: 0,
    sleepImpl: async () => {},
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429 })
  }), error => { caught = error; return true; });
  assert.equal(caught.notProcessed, true);
  assert.equal(caught.usageMetadata, undefined);
  assert.equal(caught.unmeteredAttempts, undefined);
});
