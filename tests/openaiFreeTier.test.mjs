import test from 'node:test';
import assert from 'node:assert/strict';
import { generateOpenAIContent } from '../services/aiProvider.js';
import { createOpenAIFreeBudget, openAIFreeUsage } from '../server/openaiFreeTier.js';

// Issue #258: an empty OpenAI completion was billed (tier + tokens) but the
// thrown error carried neither, so the free-tier latch and tally never saw it.
const emptyBilled = async () => new Response(JSON.stringify({
  service_tier: 'default',
  choices: [{ message: { content: '' }, finish_reason: 'length' }],
  usage: { prompt_tokens: 9000, completion_tokens: 16384, total_tokens: 25384 }
}), { status: 200 });

test('an empty OpenAI completion carries its service tier and usage on the error', async () => {
  await assert.rejects(
    () => generateOpenAIContent({ contents: 'x', config: {} }, { apiKey: 'k', maxRetries: 0, fetchImpl: emptyBilled }),
    error => error.code === 'INVALID_AI_RESPONSE'
      && error.serviceTier === 'default'
      && error.usageMetadata?.totalTokenCount === 25384
  );
});

test('free-tier accounting reads tokens and billed tier from a response or an error', async () => {
  const error = await generateOpenAIContent({ contents: 'x', config: {} }, { apiKey: 'k', maxRetries: 0, fetchImpl: emptyBilled })
    .catch(caught => caught);
  assert.deepEqual(openAIFreeUsage(error), { used: 25384, serviceTier: 'default', free: false, billed: true });

  assert.deepEqual(
    openAIFreeUsage({ serviceTier: 'incentivized-tier', usageMetadata: { totalTokenCount: 120 } }),
    { used: 120, serviceTier: 'incentivized-tier', free: true, billed: false }
  );
  // A failure that never reached a completion reports nothing.
  assert.deepEqual(openAIFreeUsage(new Error('timed out')), { used: 0, serviceTier: null, free: false, billed: false });
});

// Issue #291: the gate compared only the cached org total (refreshed every
// 5 min) against the threshold, ignoring local spend since that read and the
// estimates of requests already admitted but not yet recorded.
const CAP = 10_000_000;
const BUFFER = 250_000; // threshold 9,750,000
const fixedClock = () => new Date('2026-10-30T12:00:00Z');

test('the gate adds local spend since the last Usage API read to the cached org total', () => {
  const budget = createOpenAIFreeBudget({ dailyCap: CAP, safetyBuffer: BUFFER, shards: 2, now: fixedClock });
  budget.recordTokens(1_000_000); // spent before the read: already in the org total
  budget.setOrgUsage(9_700_000, budget.localUsed());
  const first = budget.tryReserve(20_000);
  assert.ok(first, 'fits: 9.70M + 20k <= 9.75M');
  budget.recordTokens(200_000); // spent after the read, invisible to the org total
  budget.release(first);
  assert.equal(budget.projected(20_000), 9_700_000 + 200_000 + 20_000);
  assert.equal(budget.tryReserve(20_000), null, '9.70M + 200k local + 20k > 9.75M');
});

test('in-flight reservations count against the gate until released', () => {
  const budget = createOpenAIFreeBudget({ dailyCap: CAP, safetyBuffer: BUFFER, now: fixedClock });
  budget.setOrgUsage(9_700_000, budget.localUsed());
  const a = budget.tryReserve(30_000);
  assert.ok(a);
  // A concurrent request sees the same stale org total but not a's spend.
  assert.equal(budget.tryReserve(30_000), null);
  budget.release(a);
  budget.release(a); // idempotent
  assert.ok(budget.tryReserve(30_000));
});

test('without a Usage API read the gate uses the local tally, in-flight estimates and the shard share', () => {
  const budget = createOpenAIFreeBudget({ dailyCap: CAP, safetyBuffer: BUFFER, shards: 2, now: fixedClock });
  budget.recordTokens(4_800_000);
  const a = budget.tryReserve(50_000); // 4.85M <= 4.875M
  assert.ok(a);
  assert.equal(budget.tryReserve(50_000), null); // 4.9M > 4.875M
  budget.setOrgUsage(null);
  assert.equal(budget.projected(0), 4_850_000);
});

test('an org total read on an earlier UTC day does not count toward today', () => {
  let clock = new Date('2026-10-29T23:59:00Z');
  const budget = createOpenAIFreeBudget({ dailyCap: CAP, safetyBuffer: BUFFER, now: () => clock });
  budget.recordTokens(500_000);
  budget.setOrgUsage(9_740_000, budget.localUsed());
  clock = new Date('2026-10-30T00:01:00Z');
  budget.recordTokens(100_000);
  assert.equal(budget.localUsed(), 100_000);
  assert.equal(budget.projected(1_000), 101_000);
});
