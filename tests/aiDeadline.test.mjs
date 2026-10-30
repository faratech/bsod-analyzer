import test from 'node:test';
import assert from 'node:assert/strict';
import { AIProviderError } from '../services/aiProvider.js';
import {
  createAIDeadline,
  aiRequestDeadlineMs,
  DEFAULT_AI_REQUEST_DEADLINE_MS,
  DEFAULT_AI_FINAL_RESERVE_MS,
  DEFAULT_AI_MIN_LEG_MS
} from '../server/aiDeadline.js';
import { shouldRefund } from '../server/quotaPolicy.js';

// Issue #255: one deadline bounds the whole provider chain, below Cloudflare's
// 100 s origin timeout; every leg gets min(its own timeout, what remains).

test('the request deadline defaults to 90 s and AI_REQUEST_DEADLINE_MS overrides it', () => {
  assert.equal(DEFAULT_AI_REQUEST_DEADLINE_MS, 90_000);
  assert.equal(aiRequestDeadlineMs({}), 90_000);
  assert.equal(aiRequestDeadlineMs({ AI_REQUEST_DEADLINE_MS: '45000' }), 45_000);
  assert.equal(aiRequestDeadlineMs({ AI_REQUEST_DEADLINE_MS: 'nope' }), 90_000);
});

test('each leg is capped by the remaining budget, and a leg with too little left is skipped', () => {
  let clock = 0;
  const deadline = createAIDeadline({ budgetMs: 90_000, minLegMs: 5_000, now: () => clock });
  assert.equal(deadline.legTimeoutMs(120_000), 90_000);
  assert.equal(deadline.legTimeoutMs(60_000), 60_000);
  clock = 80_000;
  assert.equal(deadline.remainingMs(), 10_000);
  assert.equal(deadline.legTimeoutMs(120_000), 10_000);
  assert.equal(deadline.canStart(), true);
  clock = 86_000;
  assert.equal(deadline.canStart(), false);
  clock = 95_000;
  assert.equal(deadline.remainingMs(), 0);
});

test('the deadline error is a retryable, refundable 504 timeout', () => {
  const error = createAIDeadline({ budgetMs: 1 }).timeoutError();
  assert.ok(error instanceof AIProviderError);
  assert.equal(error.code, 'AI_TIMEOUT');
  assert.equal(error.status, 504);
  assert.equal(error.retryable, true);
  assert.equal(shouldRefund(error), true);
});

test('a leg is aborted when the remaining budget runs out, not after its own timeout', async () => {
  const deadline = createAIDeadline({ budgetMs: 60, minLegMs: 1 });
  let seenSignal;
  const started = Date.now();
  await assert.rejects(
    deadline.runLeg(120_000, signal => {
      seenSignal = signal;
      return new Promise(() => {}); // a provider that never answers
    }, 'Experiential request timed out'),
    /Experiential request timed out/
  );
  assert.ok(Date.now() - started < 1_000, 'the leg outlived the request deadline');
  assert.equal(seenSignal.aborted, true, 'the in-flight call was not cancelled (#208)');
});

// An injected clock, not the wall clock: with the real clock a budget equal
// to minLegMs left the test passing only when creation and runLeg ran in the
// same millisecond (issue #320).
test('a leg that finishes in time resolves with its value', async () => {
  let clock = 0;
  const deadline = createAIDeadline({ budgetMs: 10_000, minLegMs: 5_000, now: () => clock });
  clock = 4_000; // time passes before the leg starts; 6 s still remain
  assert.equal(await deadline.runLeg(1_000, async () => 'ok', 'x timed out'), 'ok');
});

test('runLeg refuses to start a leg once too little of the budget remains', async () => {
  let clock = 0;
  const deadline = createAIDeadline({ budgetMs: 10_000, minLegMs: 5_000, now: () => clock });
  clock = 6_000;
  let started = false;
  await assert.rejects(
    deadline.runLeg(120_000, async () => { started = true; }, 'x timed out'),
    error => error.code === 'AI_TIMEOUT' && error.status === 504 && error.notProcessed === true
  );
  assert.equal(started, false);
});

// Issue #272: a leg that is not the last one must leave the fall-through chain
// a reserve, so one stalled provider (Experiential Luna, OpenAI free) cannot
// spend the whole deadline.
test('a non-final leg is capped so the final leg keeps a reserve', () => {
  let clock = 0;
  const deadline = createAIDeadline({ budgetMs: 90_000, minLegMs: 5_000, now: () => clock });
  assert.equal(DEFAULT_AI_FINAL_RESERVE_MS, 30_000);
  assert.equal(deadline.legTimeoutMs(90_000, { nonFinal: true }), 60_000);
  assert.equal(deadline.legTimeoutMs(40_000, { nonFinal: true }), 40_000);
  assert.equal(deadline.legTimeoutMs(90_000), 90_000, 'the final leg may use everything left');
  clock = 60_000;
  assert.equal(deadline.canStart({ nonFinal: true }), false, 'no non-final leg may eat the reserve');
  assert.equal(deadline.canStart(), true);
  assert.ok(deadline.legTimeoutMs(120_000) >= DEFAULT_AI_MIN_LEG_MS);
});

test('a non-final leg that never answers still leaves the final leg time to run', async () => {
  const deadline = createAIDeadline({ budgetMs: 600, minLegMs: 50, finalReserveMs: 250 });
  await assert.rejects(
    deadline.runLeg(10_000, () => new Promise(() => {}), 'Experiential request timed out', { nonFinal: true }),
    /Experiential request timed out/
  );
  assert.equal(deadline.canStart({ nonFinal: true }), false);
  assert.equal(deadline.canStart(), true, 'the final leg was starved');
  assert.equal(await deadline.runLeg(10_000, async () => 'report', 'DeepSeek request timed out'), 'report');
});
