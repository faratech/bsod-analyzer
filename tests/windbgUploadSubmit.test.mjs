import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createExternalWinDbgSubmit,
  createExternalWinDbgSubmitter,
  createWinDbgUploadCapGate,
  createWinDbgUploadSubmitter,
  DEFAULT_UNCONFIRMED_HOLD_MS,
  DEFAULT_WINDBG_UPLOAD_RESPONSE_BUDGET_MS,
  MAX_WINDBG_UPLOAD_RESPONSE_BUDGET_MS,
  resolveUploadResponseBudgetMs
} from '../server/windbgUploadSubmit.js';

// Issue #276: /api/windbg/upload awaited the WinDbg-API submit for up to
// 240 s, but Cloudflare cuts the origin response at 100 s, so a slow submit
// produced an HTML 524 for the browser and an upstream job nobody could poll.

const UID = 'a'.repeat(64);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('the upload response budget defaults below the Cloudflare 100 s origin timeout and is clamped', () => {
  assert.equal(DEFAULT_WINDBG_UPLOAD_RESPONSE_BUDGET_MS, 90_000);
  assert.ok(MAX_WINDBG_UPLOAD_RESPONSE_BUDGET_MS < 100_000);
  assert.equal(resolveUploadResponseBudgetMs(undefined), 90_000);
  assert.equal(resolveUploadResponseBudgetMs(''), 90_000);
  assert.equal(resolveUploadResponseBudgetMs('nope'), 90_000);
  assert.equal(resolveUploadResponseBudgetMs('-5'), 90_000);
  assert.equal(resolveUploadResponseBudgetMs('30000'), 30_000);
  assert.equal(resolveUploadResponseBudgetMs('240000'), MAX_WINDBG_UPLOAD_RESPONSE_BUDGET_MS);
});

test('a submit that finishes within the budget is returned', async () => {
  const submitter = createWinDbgUploadSubmitter({ responseBudgetMs: 200 });
  const outcome = await submitter.submitWithinBudget(UID, async () => ({ job_id: 'job-1' }));
  assert.deepEqual(outcome, { outcome: 'submitted', result: { job_id: 'job-1' }, reused: false });
});

test('a submit slower than the budget answers timeout instead of holding the response', async () => {
  const submitter = createWinDbgUploadSubmitter({ responseBudgetMs: 20 });
  const slow = deferred();
  const started = Date.now();
  const outcome = await submitter.submitWithinBudget(UID, () => slow.promise);
  assert.equal(outcome.outcome, 'timeout');
  assert.ok(Date.now() - started < 1000);
  slow.resolve({ job_id: 'late' });
});

test('the job a timed-out submit creates is adopted by the retry, not orphaned or duplicated', async () => {
  const late = [];
  const submitter = createWinDbgUploadSubmitter({
    responseBudgetMs: 20,
    onLateResult: (uid, result) => late.push([uid, result.job_id])
  });
  const slow = deferred();
  let submits = 0;
  const start = () => { submits += 1; return submits === 1 ? slow.promise : Promise.resolve({ job_id: `fresh-${submits}` }); };

  assert.equal((await submitter.submitWithinBudget(UID, start)).outcome, 'timeout');
  slow.resolve({ job_id: 'late-job' });
  await delay(5);
  assert.deepEqual(late, [[UID, 'late-job']]);

  const retry = await submitter.submitWithinBudget(UID, start);
  assert.deepEqual(retry, { outcome: 'submitted', result: { job_id: 'late-job' }, reused: true });
  assert.equal(submits, 1, 'the retry reused the late job instead of submitting again');

  // Handed out once: a later upload of the same dump submits fresh.
  const again = await submitter.submitWithinBudget(UID, start);
  assert.equal(again.result.job_id, 'fresh-2');
  assert.equal(submits, 2);
});

test('a retry while the first submit is still running joins it', async () => {
  const submitter = createWinDbgUploadSubmitter({ responseBudgetMs: 30 });
  const slow = deferred();
  let submits = 0;
  const start = () => { submits += 1; return slow.promise; };

  assert.equal((await submitter.submitWithinBudget(UID, start)).outcome, 'timeout');
  const retry = submitter.submitWithinBudget(UID, start);
  slow.resolve({ job_id: 'shared' });
  assert.deepEqual(await retry, { outcome: 'submitted', result: { job_id: 'shared' }, reused: true });
  assert.equal(submits, 1);

  // The joined request delivered the job, so it is not handed out again.
  const next = await submitter.submitWithinBudget(UID, async () => ({ job_id: 'new' }));
  assert.equal(next.result.job_id, 'new');
});

// Issue #337: the late result was kept for adoption only when nobody was
// waiting on it, so a request that joined before the first waiter's timeout
// received the job and the timed-out waiter's retry submitted a second one.
test('a timed-out waiter\'s retry adopts the job another waiter received (#337)', async () => {
  const late = [];
  const submitter = createWinDbgUploadSubmitter({ responseBudgetMs: 30, onLateResult: (uid, result) => late.push(result.job_id) });
  const slow = deferred();
  let submits = 0;
  const start = () => { submits += 1; return submits === 1 ? slow.promise : Promise.resolve({ job_id: `fresh-${submits}` }); };

  const first = submitter.submitWithinBudget(UID, start);
  await delay(10);
  const joined = submitter.submitWithinBudget(UID, start); // joins before the first times out
  assert.equal((await first).outcome, 'timeout');
  slow.resolve({ job_id: 'job-1' });
  assert.deepEqual(await joined, { outcome: 'submitted', result: { job_id: 'job-1' }, reused: true });
  await delay(5);
  assert.deepEqual(late, [], 'a waiter received the job: it is not logged as orphaned');

  const retry = await submitter.submitWithinBudget(UID, start);
  assert.deepEqual(retry, { outcome: 'submitted', result: { job_id: 'job-1' }, reused: true });
  assert.equal(submits, 1, 'the retry adopted the job instead of submitting the dump again');
  // Still handed out once.
  assert.equal((await submitter.submitWithinBudget(UID, start)).result.job_id, 'fresh-2');
});

test('the job kept for a timed-out waiter whose job another waiter received still expires (#337)', async () => {
  let clock = 1_000;
  const submitter = createWinDbgUploadSubmitter({ responseBudgetMs: 30, retainMs: 60_000, now: () => clock });
  const slow = deferred();
  const first = submitter.submitWithinBudget(UID, () => slow.promise);
  await delay(10);
  const joined = submitter.submitWithinBudget(UID, () => slow.promise);
  assert.equal((await first).outcome, 'timeout');
  slow.resolve({ job_id: 'old' });
  await joined;
  clock += 61_000;
  assert.equal((await submitter.submitWithinBudget(UID, async () => ({ job_id: 'fresh' }))).result.job_id, 'fresh');
});

test('a submit failure within the budget is thrown; a late failure is not adopted', async () => {
  const submitter = createWinDbgUploadSubmitter({ responseBudgetMs: 20 });
  await assert.rejects(
    () => submitter.submitWithinBudget(UID, async () => { throw new Error('upstream 500'); }),
    /upstream 500/
  );

  const slow = deferred();
  assert.equal((await submitter.submitWithinBudget(UID, () => slow.promise)).outcome, 'timeout');
  slow.reject(new Error('late failure'));
  await delay(5);
  let submits = 0;
  const outcome = await submitter.submitWithinBudget(UID, async () => { submits += 1; return { job_id: 'retry' }; });
  assert.equal(outcome.result.job_id, 'retry');
  assert.equal(submits, 1);
});

test('adopted late jobs expire', async () => {
  let clock = 1_000;
  const submitter = createWinDbgUploadSubmitter({ responseBudgetMs: 10, retainMs: 60_000, now: () => clock });
  const slow = deferred();
  assert.equal((await submitter.submitWithinBudget(UID, () => slow.promise)).outcome, 'timeout');
  slow.resolve({ job_id: 'old' });
  await delay(5);
  clock += 61_000;
  const outcome = await submitter.submitWithinBudget(UID, async () => ({ job_id: 'fresh' }));
  assert.equal(outcome.result.job_id, 'fresh');
});

// Issue #314: a 504 frees the route's concurrency slot while the submit keeps
// running (and holding the dump buffer plus its Blob copy) for up to 240 s, so
// the route cap of two no longer bounded the submits alive on an instance.
const hash = n => String(n).repeat(64).slice(0, 64);

test('running submits, answered or not, are capped per instance (#314)', async () => {
  const submitter = createWinDbgUploadSubmitter({ responseBudgetMs: 10, maxInFlight: 2 });
  const slow = [deferred(), deferred()];
  let submits = 0;
  const start = i => () => { submits += 1; return slow[i].promise; };

  assert.equal((await submitter.submitWithinBudget(hash(1), start(0))).outcome, 'timeout');
  assert.equal((await submitter.submitWithinBudget(hash(2), start(1))).outcome, 'timeout');
  assert.equal(submitter.inFlight(), 2);

  // A third dump while both run in the background is turned away unsubmitted.
  const busy = await submitter.submitWithinBudget(hash(3), async () => { submits += 1; return { job_id: 'x' }; });
  assert.deepEqual(busy, { outcome: 'busy' });
  assert.equal(submits, 2);

  // A retry of a dump already being submitted still joins it.
  const join = submitter.submitWithinBudget(hash(1), start(0));
  slow[0].resolve({ job_id: 'one' });
  assert.deepEqual(await join, { outcome: 'submitted', result: { job_id: 'one' }, reused: true });
  assert.equal(submitter.inFlight(), 1);

  // The settled submit freed its place.
  const third = await submitter.submitWithinBudget(hash(3), async () => ({ job_id: 'three' }));
  assert.equal(third.result.job_id, 'three');
  slow[1].resolve({ job_id: 'two' });
  await delay(5);
  assert.equal(submitter.inFlight(), 0);
});

test('a finished late job can still be adopted when the submit cap is reached (#314)', async () => {
  const submitter = createWinDbgUploadSubmitter({ responseBudgetMs: 10, maxInFlight: 1 });
  const late = deferred();
  assert.equal((await submitter.submitWithinBudget(hash(1), () => late.promise)).outcome, 'timeout');
  late.resolve({ job_id: 'late' });
  await delay(5);
  const hold = deferred();
  assert.equal((await submitter.submitWithinBudget(hash(2), () => hold.promise)).outcome, 'timeout');
  const adopted = await submitter.submitWithinBudget(hash(1), async () => { throw new Error('must not submit'); });
  assert.deepEqual(adopted, { outcome: 'submitted', result: { job_id: 'late' }, reused: true });
  hold.resolve({ job_id: 'h' });
});

test('the submit cap is released exactly once on success, failure and a synchronous throw (#314)', async () => {
  const submitter = createWinDbgUploadSubmitter({ responseBudgetMs: 50, maxInFlight: 1 });
  await submitter.submitWithinBudget(hash(1), async () => ({ job_id: 'ok' }));
  assert.equal(submitter.inFlight(), 0);
  await assert.rejects(() => submitter.submitWithinBudget(hash(2), async () => { throw new Error('async'); }), /async/);
  assert.equal(submitter.inFlight(), 0);
  await assert.rejects(() => submitter.submitWithinBudget(hash(3), () => { throw new Error('sync'); }), /sync/);
  assert.equal(submitter.inFlight(), 0);
  const ok = await submitter.submitWithinBudget(hash(4), async () => ({ job_id: 'four' }));
  assert.equal(ok.result.job_id, 'four');
  assert.equal(submitter.inFlight(), 0);
});

// Issue #315: /api/analyze awaited the WinDbg-API submit for up to 240 s behind
// Cloudflare's 100 s and recorded the reuse entry only after it returned, so a
// worker resubmitting after the edge cut it started a second upstream job.
function externalHarness({ budget = 20, maxInFlight = 2 } = {}) {
  const recent = new Map();
  const submitter = createWinDbgUploadSubmitter({ responseBudgetMs: budget, retainMs: 0, maxInFlight });
  const submit = createExternalWinDbgSubmit({ submitter, recent, ttlMs: 60_000 });
  return { recent, submitter, submit };
}

test('/api/analyze submits answer within the budget and a resubmission joins the running submit (#315)', async () => {
  const { recent, submitter, submit } = externalHarness();
  const slow = deferred();
  let submits = 0;
  const start = () => { submits += 1; return slow.promise; };

  const started = Date.now();
  assert.deepEqual(await submit(UID, start), { outcome: 'timeout' });
  assert.ok(Date.now() - started < 1000);
  assert.equal(submitter.inFlight(), 1, 'the submit keeps running, registered under the file hash');

  const resubmit = submit(UID, start);
  slow.resolve({ uid: 'signed-uid', upstreamJobId: 'job-1' });
  assert.deepEqual(await resubmit, { outcome: 'submitted', result: { uid: 'signed-uid', upstreamJobId: 'job-1' }, reused: true });
  assert.equal(submits, 1, 'no second upstream job');
  assert.equal(recent.get(UID).uid, 'signed-uid');
});

test('a late /api/analyze submit records its uid for the next resubmission (#315)', async () => {
  const { recent, submit } = externalHarness();
  const slow = deferred();
  assert.deepEqual(await submit(UID, () => slow.promise), { outcome: 'timeout' });
  assert.equal(recent.get(UID), undefined);
  slow.resolve({ uid: 'late-uid', upstreamJobId: 'job-late' });
  await delay(5);
  assert.equal(recent.get(UID).uid, 'late-uid', 'the job created after the timeout is not orphaned');
  assert.ok(recent.get(UID).expiresAt > Date.now());

  // Dropping the reuse entry (a degraded report, #256) means a fresh run:
  // the submitter keeps no adoptable copy of its own.
  recent.delete(UID);
  let submits = 0;
  const fresh = await submit(UID, async () => { submits += 1; return { uid: 'fresh-uid', upstreamJobId: 'job-2' }; });
  assert.equal(fresh.result.uid, 'fresh-uid');
  assert.equal(fresh.reused, false);
  assert.equal(submits, 1);
});

test('/api/analyze submits past the per-instance cap are turned away; failures record nothing (#315)', async () => {
  const { recent, submit } = externalHarness({ maxInFlight: 1 });
  const slow = deferred();
  assert.deepEqual(await submit(hash(1), () => slow.promise), { outcome: 'timeout' });
  let called = false;
  assert.deepEqual(await submit(hash(2), async () => { called = true; return { uid: 'x' }; }), { outcome: 'busy' });
  assert.equal(called, false);
  slow.reject(new Error('upstream 500'));
  await delay(5);
  assert.equal(recent.size, 0);
  await assert.rejects(() => submit(hash(3), async () => { throw new Error('rejected'); }), /rejected/);
  assert.equal(recent.size, 0);
});

// Issue #328: a submit that failed ambiguously (gateway error, timeout,
// garbled answer) may have created an upstream job nobody can adopt. A re-run
// of the same dump within the ownership window must not submit it again.
const unconfirmed = error => error?.unconfirmed === true;
const ambiguousError = () => Object.assign(new Error('bad gateway'), { unconfirmed: true });

test('after an ambiguous submit failure the same dump is held, not submitted again, for the window (#328)', async () => {
  let clock = 1_000;
  const submitter = createWinDbgUploadSubmitter({ responseBudgetMs: 50, retainMs: 60_000, isUnconfirmedFailure: unconfirmed, now: () => clock });
  await assert.rejects(() => submitter.submitWithinBudget(UID, async () => { throw ambiguousError(); }), /bad gateway/);
  let submits = 0;
  const start = async () => { submits += 1; return { job_id: 'second' }; };
  assert.deepEqual(await submitter.submitWithinBudget(UID, start), { outcome: 'unconfirmed' });
  clock += 59_000;
  assert.deepEqual(await submitter.submitWithinBudget(UID, start), { outcome: 'unconfirmed' }, 'still held inside the window');
  assert.equal(submits, 0);
  // Another dump is unaffected.
  assert.equal((await submitter.submitWithinBudget(hash(7), start)).result.job_id, 'second');
  clock += 2_000;
  assert.equal((await submitter.submitWithinBudget(UID, start)).result.job_id, 'second', 'a fresh submit after the window');
  assert.equal(submits, 2);
});

test('an ambiguous failure after the timeout answer holds the dump too (#328)', async () => {
  const submitter = createWinDbgUploadSubmitter({ responseBudgetMs: 10, retainMs: 60_000, isUnconfirmedFailure: unconfirmed });
  const slow = deferred();
  assert.equal((await submitter.submitWithinBudget(UID, () => slow.promise)).outcome, 'timeout');
  slow.reject(ambiguousError());
  await delay(5);
  assert.deepEqual(await submitter.submitWithinBudget(UID, async () => { throw new Error('must not submit'); }), { outcome: 'unconfirmed' });
});

test('a definite submit failure does not hold the dump (#328)', async () => {
  const submitter = createWinDbgUploadSubmitter({ responseBudgetMs: 50, retainMs: 60_000, isUnconfirmedFailure: unconfirmed });
  await assert.rejects(() => submitter.submitWithinBudget(UID, async () => { throw new Error('rejected'); }), /rejected/);
  assert.equal((await submitter.submitWithinBudget(UID, async () => ({ job_id: 'ok' }))).result.job_id, 'ok');
});

test('a late job is still adopted after the timeout answer when it succeeds (#276, #328)', async () => {
  const submitter = createWinDbgUploadSubmitter({ responseBudgetMs: 10, retainMs: 60_000, isUnconfirmedFailure: unconfirmed });
  const slow = deferred();
  assert.equal((await submitter.submitWithinBudget(UID, () => slow.promise)).outcome, 'timeout');
  slow.resolve({ job_id: 'late' });
  await delay(5);
  const adopted = await submitter.submitWithinBudget(UID, async () => { throw new Error('must not submit'); });
  assert.deepEqual([adopted.outcome, adopted.result.job_id, adopted.reused], ['submitted', 'late', true]);
});

// Issue #336: /api/analyze used to keep no hold (its submitter had retainMs 0,
// so the derived holdMs was 0 too): the forum worker's resubmission after an
// ambiguous failure queued a second upstream job.
const upstream502 = () => Object.assign(new Error('WinDBG job submit failed with status 502'), { code: 'WINDBG_UPSTREAM_ERROR', upstreamStatus: 502 });

function realExternalHarness({ budget = 20, clock } = {}) {
  const recent = new Map();
  const submitter = createExternalWinDbgSubmitter({ responseBudgetMs: budget, maxInFlight: 2, ...(clock ? { now: () => clock.now } : {}) });
  const submit = createExternalWinDbgSubmit({ submitter, recent, ttlMs: 60_000 });
  return { recent, submitter, submit };
}

test('the /api/analyze submitter holds a dump after an ambiguous upstream failure (#336)', async () => {
  const clock = { now: 1_000_000 };
  const { recent, submitter, submit } = realExternalHarness({ clock });
  await assert.rejects(() => submit(UID, async () => { throw upstream502(); }), /502/);
  let submits = 0;
  const start = async () => { submits += 1; return { uid: 'second', upstreamJobId: 'job-2' }; };
  assert.deepEqual(await submit(UID, start), { outcome: 'unconfirmed' });
  assert.equal(submits, 0, 'the resubmission did not queue a second upstream job');
  assert.equal(submitter.holdRemainingMs(UID), DEFAULT_UNCONFIRMED_HOLD_MS);
  clock.now += 9 * 60 * 1000;
  assert.deepEqual(await submit(UID, start), { outcome: 'unconfirmed' }, 'held for the whole window although retainMs is 0');
  assert.equal(submitter.holdRemainingMs(UID), 60 * 1000);
  clock.now += 61 * 1000;
  assert.equal(submitter.holdRemainingMs(UID), 0);
  assert.equal((await submit(UID, start)).result.uid, 'second', 'released after the hold');
  assert.equal(submits, 1);
  assert.equal(recent.get(UID).uid, 'second');
});

test('the /api/analyze submitter holds a dump whose late submit failed ambiguously after the 504 (#336)', async () => {
  const { submit } = realExternalHarness({ budget: 10 });
  const slow = deferred();
  assert.deepEqual(await submit(UID, () => slow.promise), { outcome: 'timeout' });
  slow.reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
  await delay(5);
  assert.deepEqual(await submit(UID, async () => { throw new Error('must not submit'); }), { outcome: 'unconfirmed' });
});

test('the /api/analyze submitter does not hold after a definite failure, nor adopt on its own (#336, #315)', async () => {
  const { recent, submit } = realExternalHarness({ budget: 10 });
  const rejected = Object.assign(new Error('WinDBG job submit failed with status 400'), { code: 'WINDBG_UPSTREAM_ERROR', upstreamStatus: 400 });
  await assert.rejects(() => submit(UID, async () => { throw rejected; }), /400/);
  assert.equal((await submit(UID, async () => ({ uid: 'ok', upstreamJobId: 'j' }))).result.uid, 'ok');
  // retainMs stays 0: `recent` remains the only reuse record.
  const slow = deferred();
  assert.deepEqual(await submit(hash(9), () => slow.promise), { outcome: 'timeout' });
  slow.resolve({ uid: 'late', upstreamJobId: 'late-job' });
  await delay(5);
  assert.equal(recent.get(hash(9)).uid, 'late');
  recent.delete(hash(9));
  assert.equal((await submit(hash(9), async () => ({ uid: 'fresh', upstreamJobId: 'j2' }))).result.uid, 'fresh');
});

test('the hold after an ambiguous failure ends after 10 minutes even when results are retained for an hour (#328)', async () => {
  let clock = 1_000_000;
  const submitter = createWinDbgUploadSubmitter({ responseBudgetMs: 50, retainMs: 60 * 60 * 1000, isUnconfirmedFailure: unconfirmed, now: () => clock });
  await submitter.submitWithinBudget(UID, async () => { throw ambiguousError(); }).catch(() => {});
  clock += 9 * 60 * 1000;
  assert.deepEqual(await submitter.submitWithinBudget(UID, async () => { throw new Error('must not submit'); }), { outcome: 'unconfirmed' }, 'still held at 9 minutes');
  clock += 2 * 60 * 1000;
  const result = await submitter.submitWithinBudget(UID, async () => ({ job_id: 'J2' }));
  assert.notEqual(result.outcome, 'unconfirmed', 'released after 10 minutes');
});

// Issue #338: the #314 cap answered WINDBG_UPLOAD_BUSY only after the whole
// dump was buffered, validated and hashed. The gate refuses before the body is
// read; the browser's advisory X-File-Hash lets a retry that joins or adopts
// its own submit through at the cap (the handler re-checks with the real hash).
function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: null };
  res.set = (name, value) => { res.headers[name] = value; return res; };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; return res; };
  return res;
}

function runGate(gate, headers = {}) {
  const res = fakeRes();
  let passed = false;
  gate({ headers }, res, () => { passed = true; });
  return { passed, res };
}

test('the upload cap gate refuses a new dump at the cap before the body is read (#338)', async () => {
  const submitter = createWinDbgUploadSubmitter({ responseBudgetMs: 10, maxInFlight: 2 });
  const gate = createWinDbgUploadCapGate({ submitter });
  assert.equal(runGate(gate).passed, true, 'below the cap everything passes');
  const slow = deferred();
  await submitter.submitWithinBudget(hash(1), () => slow.promise);
  await submitter.submitWithinBudget(hash(2), () => slow.promise);
  assert.equal(submitter.inFlight(), 2);

  for (const headers of [{}, { 'x-file-hash': hash(3) }, { 'x-file-hash': 'not-a-hash' }]) {
    const { passed, res } = runGate(gate, headers);
    assert.equal(passed, false, JSON.stringify(headers));
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.code, 'WINDBG_UPLOAD_BUSY');
    assert.equal(res.headers['Retry-After'], '15');
  }
  // The retry of a dump still being submitted joins it: let through.
  assert.equal(runGate(gate, { 'x-file-hash': hash(1) }).passed, true);
  assert.equal(runGate(gate, { 'x-file-hash': hash(2).toUpperCase() }).passed, true);

  slow.resolve({ job_id: 'late' });
  await delay(5);
  assert.equal(submitter.inFlight(), 0);
  assert.equal(runGate(gate, { 'x-file-hash': hash(3) }).passed, true, 'cap released');
});

test('the upload cap gate lets an adoptable late job through at the cap (#338, #314)', async () => {
  const submitter = createWinDbgUploadSubmitter({ responseBudgetMs: 10, maxInFlight: 1 });
  const gate = createWinDbgUploadCapGate({ submitter });
  const done = deferred();
  await submitter.submitWithinBudget(hash(1), () => done.promise);
  done.resolve({ job_id: 'late' });
  await delay(5);
  const slow = deferred();
  await submitter.submitWithinBudget(hash(2), () => slow.promise);
  assert.equal(runGate(gate, { 'x-file-hash': hash(3) }).passed, false);
  assert.equal(runGate(gate, { 'x-file-hash': hash(1) }).passed, true, 'its late job is waiting to be adopted');
  slow.resolve({ job_id: 'x' });
});
