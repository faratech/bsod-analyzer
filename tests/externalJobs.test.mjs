import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createExternalJobCodec,
  createExternalJobResolver,
  isExternalJobUid,
  isPermanentUpstreamError,
  analyzeHeldSubmissionResponse,
  analyzeSubmitFailureResponse,
  createExternalSubmissionReuse
} from '../server/externalJobs.js';

const SECRET = 'external-job-secret-0123456789abcdef';
const JOB = {
  fileHash: 'abcdef0123456789',
  upstreamJobId: 'job-7',
  fileName: 'crash.dmp',
  fileSize: 65536,
  dumpType: 'minidump',
  originalZip: 'dumps.zip'
};
const MAP = status => ({ done: 'completed', running: 'processing', broken: 'failed' })[status] || 'pending';

function harness({ cached = null, upstream = async () => ({ status: 'running' }), now = () => Date.now(), findRelated } = {}) {
  const calls = { upstream: 0, reports: 0, cached: [], stats: 0, corpus: [] };
  const resolver = createExternalJobResolver({
    getUpstreamJob: async jobId => {
      calls.upstream += 1;
      return upstream(jobId);
    },
    mapUpstreamStatus: MAP,
    extractAnalysis: job => ({ analysisText: job.result, analysisSignalText: '', structured: {} }),
    loadCachedAnalysis: async () => cached,
    cacheAnalysis: async (hash, analysis) => { calls.cached.push([hash, analysis.analysisText]); return true; },
    generateReport: async (job, analysis) => {
      calls.reports += 1;
      return { summary: `report for ${job.fileName}`, evidence: analysis.windbgOutput };
    },
    recordStats: () => { calls.stats += 1; },
    recordCorpus: (job, upstream) => { calls.corpus.push([job.fileHash, upstream]); },
    ...(findRelated ? { findRelated } : {}),
    deadlineMs: 15 * 60 * 1000,
    now,
    logger: { warn() {} }
  });
  return { resolver, calls };
}

test('job uids round-trip their metadata and reject tampering', () => {
  const codec = createExternalJobCodec({ secret: SECRET });
  const now = Date.now();
  const uid = codec.issue(JOB, now);
  assert.equal(isExternalJobUid(uid), true);
  assert.deepEqual(codec.parse(uid), { uid, ...JOB, acceptedAt: now });

  assert.equal(codec.parse(uid.slice(0, -2) + (uid.endsWith('AA') ? 'BB' : 'AA')), null);
  assert.equal(codec.parse('API-1790000000000-abcdefabcdef'), null);
  assert.equal(isExternalJobUid('API-1790000000000-abcdefabcdef'), false);
  assert.equal(createExternalJobCodec({ secret: 'other' }).parse(uid), null);

  const long = codec.issue({ ...JOB, fileName: 'x'.repeat(300), originalZip: 'y'.repeat(300), upstreamJobId: 'a'.repeat(64) });
  assert.ok(long.length < 1024, `uid length ${long.length}`);
  assert.equal(codec.parse(long).fileName.length, 120);
});

test('job uids expire after maxAgeMs and reject future issue times (issue #136)', () => {
  const codec = createExternalJobCodec({ secret: SECRET, maxAgeMs: 60_000 });
  const issuedAt = Date.parse('2026-10-09T12:00:00Z');
  const uid = codec.issue(JOB, issuedAt);
  assert.equal(codec.parse(uid, issuedAt + 59_000)?.fileHash, JOB.fileHash);
  assert.equal(codec.parse(uid, issuedAt + 61_000), null);
  assert.equal(codec.parse(codec.issue(JOB, issuedAt + 10 * 60_000), issuedAt), null);
  // A trailing character no longer yields a second, distinct-looking uid.
  assert.equal(codec.parse(`${uid}=`, issuedAt), null);
});

test('equivalent uids for one job share one resolution and one report (issue #136)', async () => {
  const codec = createExternalJobCodec({ secret: SECRET });
  const { resolver, calls } = harness({ upstream: async () => ({ status: 'done', result: 'kd> !analyze -v' }) });
  const first = codec.parse(codec.issue(JOB, Date.now() - 1000));
  const second = codec.parse(codec.issue(JOB, Date.now()));
  assert.notEqual(first.uid, second.uid);
  const [a, b] = await Promise.all([resolver.resolve(first), resolver.resolve(second)]);
  assert.equal(a.status, 'completed');
  assert.equal(b, a);
  assert.equal((await resolver.resolve(second)).status, 'completed');
  assert.equal(calls.reports, 1, 'one AI report per job, however many uid strings poll it');
  assert.equal(calls.stats, 1);
});

test('a cached WinDBG analysis completes without touching the upstream', async () => {
  const codec = createExternalJobCodec({ secret: SECRET });
  const job = codec.parse(codec.issue(JOB));
  const { resolver, calls } = harness({ cached: { windbgOutput: 'BUGCHECK_CODE: 7e' } });

  const result = await resolver.resolve(job);
  assert.equal(result.status, 'completed');
  assert.equal(result.report.evidence, 'BUGCHECK_CODE: 7e');
  assert.equal(calls.upstream, 0);

  await resolver.resolve(job); // memoized
  assert.equal(calls.reports, 1);
});

test('running upstream jobs stay processing until the deadline, then fail', async () => {
  let clock = Date.now();
  const codec = createExternalJobCodec({ secret: SECRET });
  const job = codec.parse(codec.issue(JOB, clock));
  const { resolver } = harness({ now: () => clock });

  assert.deepEqual(await resolver.resolve(job), { status: 'processing' });
  clock += 16 * 60 * 1000;
  const late = await resolver.resolve(job);
  assert.equal(late.status, 'failed');
  assert.match(late.error, /valid Windows crash dump/);
});

test('completed upstream jobs cache the analysis, record stats once, and share one resolution', async () => {
  const codec = createExternalJobCodec({ secret: SECRET });
  const job = codec.parse(codec.issue(JOB));
  const { resolver, calls } = harness({ upstream: async () => ({ status: 'done', result: 'kd> !analyze -v' }) });

  const [a, b] = await Promise.all([resolver.resolve(job), resolver.resolve(job)]);
  assert.equal(a, b);
  assert.equal(a.status, 'completed');
  assert.equal(a.report.evidence, 'kd> !analyze -v');
  assert.equal(calls.upstream, 1);
  assert.deepEqual(calls.cached, [[JOB.fileHash, 'kd> !analyze -v']]);
  assert.equal(calls.stats, 1);
  assert.deepEqual(calls.corpus, [[JOB.fileHash, { status: 'done', result: 'kd> !analyze -v' }]]);
});

test('upstream failures: failed jobs and permanent errors fail, transient errors retry', async () => {
  const codec = createExternalJobCodec({ secret: SECRET });

  const broken = harness({ upstream: async () => ({ status: 'broken' }) });
  assert.equal((await broken.resolver.resolve(codec.parse(codec.issue(JOB)))).status, 'failed');

  const gone = harness({ upstream: async () => { throw Object.assign(new Error('not found'), { upstreamStatus: 404 }); } });
  assert.equal((await gone.resolver.resolve(codec.parse(codec.issue(JOB)))).status, 'failed');

  const flaky = harness({ upstream: async () => { throw Object.assign(new Error('bad gateway'), { upstreamStatus: 502 }); } });
  await assert.rejects(flaky.resolver.resolve(codec.parse(codec.issue(JOB))), /bad gateway/);

  assert.equal(isPermanentUpstreamError({ upstreamStatus: 404 }), true);
  assert.equal(isPermanentUpstreamError({ upstreamStatus: 429 }), false);
  assert.equal(isPermanentUpstreamError({ upstreamStatus: 423 }), false);
  assert.equal(isPermanentUpstreamError(new Error('network')), false);
});

test('a cache-hit job whose cache entry is gone polls until the deadline, then fails (issue #174)', async () => {
  let clock = Date.now();
  const codec = createExternalJobCodec({ secret: SECRET });
  const job = codec.parse(codec.issue({ ...JOB, upstreamJobId: undefined }, clock));
  const { resolver, calls } = harness({ now: () => clock });
  // A transient cache miss is not terminal and is not memoized as failed.
  assert.deepEqual(await resolver.resolve(job), { status: 'processing' });
  assert.equal(calls.upstream, 0);
  clock += 16 * 60 * 1000;
  assert.equal((await resolver.resolve(job)).status, 'failed');
  assert.equal(calls.upstream, 0);
});

test('a cache-hit job recovers when the cache repopulates before the deadline (issue #174)', async () => {
  const codec = createExternalJobCodec({ secret: SECRET });
  const job = codec.parse(codec.issue({ ...JOB, upstreamJobId: undefined }));
  let cached = null;
  const resolver = createExternalJobResolver({
    getUpstreamJob: async () => { throw new Error('no upstream for cache-hit jobs'); },
    mapUpstreamStatus: MAP,
    extractAnalysis: x => x,
    loadCachedAnalysis: async () => cached,
    cacheAnalysis: async () => {},
    generateReport: async () => ({ summary: 'recovered' }),
    deadlineMs: 15 * 60 * 1000,
    logger: { warn() {} }
  });
  assert.equal((await resolver.resolve(job)).status, 'processing');
  cached = { windbgOutput: 'BUGCHECK_CODE: 7e' };
  assert.equal((await resolver.resolve(job)).status, 'completed');
});

test('completed jobs carry related forum threads, memoized with the result', async () => {
  const codec = createExternalJobCodec({ secret: SECRET });
  const job = codec.parse(codec.issue(JOB));
  const seen = [];
  const thread = { threadId: 338855, title: 'DPC_WATCHDOG_VIOLATION', url: 'https://windowsforum.com/threads/338855/', match: 'code' };
  const { resolver } = harness({
    upstream: async () => ({ status: 'done', result: 'kd> !analyze -v' }),
    findRelated: async (_job, analysis, report) => { seen.push([analysis.windbgOutput, report.summary]); return [thread]; }
  });

  const result = await resolver.resolve(job);
  assert.deepEqual(result.relatedThreads, [thread]);
  await resolver.resolve(job);
  assert.deepEqual(seen, [['kd> !analyze -v', 'report for crash.dmp']]);
});

test('a failing related-thread lookup never fails the job', async () => {
  const codec = createExternalJobCodec({ secret: SECRET });
  const job = codec.parse(codec.issue(JOB));
  const { resolver } = harness({
    cached: { windbgOutput: 'BUGCHECK_CODE: 7e' },
    findRelated: async () => { throw new Error('forum down'); }
  });
  const result = await resolver.resolve(job);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.relatedThreads, []);

  const defaults = harness({ cached: { windbgOutput: 'BUGCHECK_CODE: 7e' } });
  assert.deepEqual((await defaults.resolver.resolve(codec.parse(codec.issue(JOB)))).relatedThreads, []);
});

test('an upstream 400 on submit is a non-retryable 4xx for the API caller (#269)', () => {
  const rejected = Object.assign(new Error('File is not a recognized Windows crash dump'), { upstreamStatus: 400 });
  const { status, body } = analyzeSubmitFailureResponse(rejected, 1.5);
  assert.equal(status, 422);
  assert.equal(body.success, false);
  assert.equal(body.code, 'DUMP_REJECTED');
  assert.equal(body.upstreamStatus, 400);
  assert.doesNotMatch(body.error, /try again/i);
});

test('upstream auth failures and internal errors stay a retryable 500 (#269)', () => {
  for (const error of [
    Object.assign(new Error('bad key'), { upstreamStatus: 401 }),
    Object.assign(new Error('bad key'), { upstreamStatus: 403 }),
    new Error('fetch failed')
  ]) {
    const { status, body } = analyzeSubmitFailureResponse(error, 2);
    assert.equal(status, 500, error.message);
    assert.equal(body.code, 'ANALYSIS_INIT_FAILED');
    assert.equal(body.processingTime, 2);
  }
});

// Issue #334: an upstream outcome that may have created a job (a 202 without
// job id, a garbled 2xx, an upstream 5xx, a connection lost mid-request) was
// answered as a local 500 "internal error".
test('an unconfirmed upstream submit outcome is a 502, not a local 500 (#334)', () => {
  for (const error of [
    Object.assign(new Error('WinDBG job submit response did not include job_id'), { code: 'WINDBG_UPSTREAM_NO_JOB_ID', upstreamStatus: 202 }),
    Object.assign(new Error('bad json'), { code: 'WINDBG_UPSTREAM_INVALID_JSON', upstreamStatus: 200 }),
    Object.assign(new Error('down'), { upstreamStatus: 503 }),
    Object.assign(new Error('bad gateway'), { upstreamStatus: 502 }),
    Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) })
  ]) {
    const { status, body } = analyzeSubmitFailureResponse(error, 2);
    assert.equal(status, 502, error.message);
    assert.equal(body.code, 'ANALYSIS_INIT_FAILED', error.message);
    assert.doesNotMatch(body.error, /internal error/i, error.message);
    assert.equal(body.processingTime, 2);
  }
});

// Issue #336: a resubmission held after an ambiguous failure gets a coded,
// non-retryable answer that says when the hold ends; the ambiguous failure
// itself says it is not to be retried at once.
test('a held /api/analyze resubmission answers 409 ANALYSIS_PENDING with the rest of the hold as Retry-After (#336)', () => {
  const { status, body, headers } = analyzeHeldSubmissionResponse(90_500, 3);
  assert.equal(status, 409);
  assert.equal(body.success, false);
  assert.equal(body.code, 'ANALYSIS_PENDING');
  assert.equal(body.retryable, false);
  assert.equal(body.processingTime, 3);
  assert.match(body.error, /may still be processing/i);
  assert.equal(headers['Retry-After'], '91');
  assert.equal(analyzeHeldSubmissionResponse(0, 1).headers['Retry-After'], '1');
  const unconfirmed = analyzeSubmitFailureResponse(Object.assign(new Error('bad gateway'), { upstreamStatus: 502 }), 2);
  assert.equal(unconfirmed.body.retryable, false);
});

test('upstream try-again-later statuses on submit are a retryable 503 with Retry-After (#327)', () => {
  for (const [error, retryAfter] of [
    [Object.assign(new Error('Queue full'), { upstreamStatus: 429 }), '15'],
    [Object.assign(new Error('Insufficient storage'), { upstreamStatus: 507 }), '30'],
    [Object.assign(new Error('timeout'), { upstreamStatus: 408 }), '15']
  ]) {
    const { status, body, headers } = analyzeSubmitFailureResponse(error, 2);
    assert.equal(status, 503, error.message);
    assert.equal(body.code, 'ANALYSIS_RETRY_LATER');
    assert.equal(body.retryable, true);
    assert.equal(headers['Retry-After'], retryAfter);
    assert.doesNotMatch(body.error, /rejected|crash dump/i);
  }
  assert.match(analyzeSubmitFailureResponse(Object.assign(new Error('x'), { upstreamStatus: 507 }), 1).body.error, /out of space/);
  // Not a refusal of the file: no longer DUMP_REJECTED.
  assert.notEqual(analyzeSubmitFailureResponse(Object.assign(new Error('x'), { upstreamStatus: 404 }), 1).body.code, 'DUMP_REJECTED');
});

// Issue #256: a transient AI failure yields a degraded aiAvailable:false
// report. It must not be finalized as the job's completed result while the
// deadline allows a retry, and must not be memoized for the result TTL.
function degradedHarness({ now }) {
  const state = { aiUp: false, reports: 0, stats: 0, upstream: 0, degraded: [] };
  const resolver = createExternalJobResolver({
    getUpstreamJob: async () => { state.upstream += 1; return { status: 'done', result: 'windbg text' }; },
    mapUpstreamStatus: MAP,
    extractAnalysis: job => ({ analysisText: job.result, analysisSignalText: '', structured: {} }),
    loadCachedAnalysis: async () => null,
    cacheAnalysis: async () => true,
    generateReport: async () => {
      state.reports += 1;
      return state.aiUp ? { summary: 'real', aiAvailable: true } : { summary: 'degraded', aiAvailable: false, aiError: 'AI interpretation unavailable' };
    },
    recordStats: () => { state.stats += 1; },
    onDegraded: job => state.degraded.push(job.fileHash),
    deadlineMs: 15 * 60 * 1000,
    resultTtlMs: 2 * 60 * 60 * 1000,
    degradedRetryMs: 60 * 1000,
    now,
    logger: { warn() {} }
  });
  return { resolver, state };
}

test('a degraded report keeps the job processing and retries the AI step (issue #256)', async () => {
  let clock = 1_000_000;
  const { resolver, state } = degradedHarness({ now: () => clock });
  const job = { uid: 'APIv2.x'.padEnd(30, 'x'), ...JOB, acceptedAt: clock };

  assert.deepEqual(await resolver.resolve(job), { status: 'processing' });
  assert.equal(state.reports, 1);

  // Inside the retry interval: no new AI attempt.
  clock += 10_000;
  assert.deepEqual(await resolver.resolve(job), { status: 'processing' });
  assert.equal(state.reports, 1);

  // After recovery, a later poll regenerates and completes with the real report,
  // without re-recording stats or refetching the upstream analysis.
  state.aiUp = true;
  clock += 60_000;
  const done = await resolver.resolve(job);
  assert.equal(done.status, 'completed');
  assert.equal(done.report.aiAvailable, true);
  assert.equal(state.reports, 2);
  assert.equal(state.stats, 1);
  assert.equal(state.upstream, 1);
  assert.deepEqual(state.degraded, []);
});

test('a degraded report completes at the deadline but is not memoized for the result TTL (issue #256)', async () => {
  let clock = 1_000_000;
  const { resolver, state } = degradedHarness({ now: () => clock });
  const job = { uid: 'APIv2.y'.padEnd(30, 'y'), ...JOB, acceptedAt: clock - 15 * 60 * 1000 };

  const result = await resolver.resolve(job);
  assert.equal(result.status, 'completed');
  assert.equal(result.report.aiAvailable, false);
  assert.deepEqual(state.degraded, [JOB.fileHash]);

  state.aiUp = true;
  clock += 61_000;
  const again = await resolver.resolve(job);
  assert.equal(again.report.aiAvailable, true);
  assert.equal(state.reports, 2);
});

// Issue #305: the status poll creates the AI deadline when it arrives, so the
// cache read and upstream fetch before the report count against it; the
// resolver hands the poll's context on to the report generator.
test('the context given to resolve reaches generateReport', async () => {
  const codec = createExternalJobCodec({ secret: SECRET });
  const job = codec.parse(codec.issue(JOB));
  const seen = [];
  const resolver = createExternalJobResolver({
    getUpstreamJob: async () => ({ status: 'done', result: 'kd> !analyze -v' }),
    mapUpstreamStatus: MAP,
    extractAnalysis: upstream => ({ analysisText: upstream.result, analysisSignalText: '', structured: {} }),
    loadCachedAnalysis: async () => null,
    cacheAnalysis: async () => true,
    generateReport: async (j, analysis, context) => {
      seen.push(context);
      return { summary: 'ok' };
    },
    logger: { warn() {} }
  });
  const deadline = { remainingMs: () => 80_000 };
  assert.equal((await resolver.resolve(job, { deadline })).status, 'completed');
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.deadline, deadline);
});

// Issue #329: a failed job kept its reuse entry, so every resubmission of the
// dump within the reuse window got the failed uid back and no new upstream job.
function failingHarness({ upstream, loadCached = async () => null, now = () => Date.now() }) {
  const failedCalls = [];
  const calls = { upstream: 0 };
  const resolver = createExternalJobResolver({
    getUpstreamJob: async jobId => { calls.upstream += 1; return upstream(jobId); },
    mapUpstreamStatus: MAP,
    extractAnalysis: job => ({ analysisText: job.result, analysisSignalText: '', structured: {} }),
    loadCachedAnalysis: loadCached,
    cacheAnalysis: async () => true,
    generateReport: async () => ({ summary: 'ok' }),
    onFailed: (job, category) => failedCalls.push([job.upstreamJobId ?? null, category]),
    deadlineMs: 15 * 60 * 1000,
    now,
    logger: { warn() {} }
  });
  return { resolver, failedCalls, calls };
}

test('failures a fresh submission can fix call onFailed; the old uid still answers failed (issue #329)', async () => {
  const codec = createExternalJobCodec({ secret: SECRET });
  const cases = [
    ['upstream_failed', async () => ({ status: 'broken', error_category: 'worker' })],
    ['upstream_failed', async () => ({ status: 'broken', error_category: 'timeout' })],
    ['upstream_failed', async () => ({ status: 'broken' })],
    ['permanent_upstream_error', async () => { throw Object.assign(new Error('not found'), { upstreamStatus: 404 }); }],
    ['empty_analysis', async () => ({ status: 'done', result: '' })]
  ];
  for (const [category, upstream] of cases) {
    const { resolver, failedCalls, calls } = failingHarness({ upstream });
    const job = codec.parse(codec.issue(JOB));
    assert.equal((await resolver.resolve(job)).status, 'failed', category);
    assert.deepEqual(failedCalls, [[JOB.upstreamJobId, category]], category);
    // Pollers of the old uid keep getting the memoized failure.
    assert.equal((await resolver.resolve(job)).status, 'failed', category);
    assert.equal(calls.upstream, 1, `${category}: memoized`);
    assert.equal(failedCalls.length, 1, `${category}: reported once`);
  }

  let clock = Date.now();
  const stuck = failingHarness({ upstream: async () => ({ status: 'running' }), now: () => clock });
  const job = codec.parse(codec.issue(JOB, clock));
  assert.equal((await stuck.resolver.resolve(job)).status, 'processing');
  clock += 16 * 60 * 1000;
  assert.equal((await stuck.resolver.resolve(job)).status, 'failed');
  assert.deepEqual(stuck.failedCalls, [[JOB.upstreamJobId, 'deadline_exceeded']]);
});

test('a failure caused by the dump itself keeps the reuse entry (issue #329)', async () => {
  const codec = createExternalJobCodec({ secret: SECRET });
  for (const category of ['cdb', 'upload']) {
    const { resolver, failedCalls } = failingHarness({ upstream: async () => ({ status: 'broken', error_category: category }) });
    assert.equal((await resolver.resolve(codec.parse(codec.issue(JOB)))).status, 'failed');
    assert.deepEqual(failedCalls, [], category);
  }
});

test('a failed cache-hit job is not memoized, since the next cache-hit uid shares its key (issue #329)', async () => {
  let clock = Date.now();
  const codec = createExternalJobCodec({ secret: SECRET });
  let cached = null;
  const { resolver, failedCalls } = failingHarness({
    upstream: async () => { throw new Error('cache-hit jobs have no upstream job'); },
    loadCached: async () => cached,
    now: () => clock
  });
  const hit = { ...JOB, upstreamJobId: undefined };
  const old = codec.parse(codec.issue(hit, clock));
  clock += 16 * 60 * 1000;
  assert.equal((await resolver.resolve(old)).status, 'failed');
  assert.deepEqual(failedCalls, [[null, 'cached_result_unavailable']]);
  // The cache repopulates and the dump is submitted again: the new uid is not
  // handed the old failure.
  cached = { windbgOutput: 'BUGCHECK_CODE: 7e' };
  assert.equal((await resolver.resolve(codec.parse(codec.issue(hit, clock), clock))).status, 'completed');
});

test('forget drops the reuse entry only while it still points at the failed upstream job (issue #329)', () => {
  const codec = createExternalJobCodec({ secret: SECRET });
  const recent = new Map();
  const reuse = createExternalSubmissionReuse({ recent, codec });
  const failedUid = codec.issue(JOB);
  const failed = codec.parse(failedUid);

  recent.set(JOB.fileHash, { uid: codec.issue({ ...JOB, upstreamJobId: 'job-8' }), expiresAt: Date.now() + 60_000 });
  reuse.forget(failed);
  assert.equal(recent.has(JOB.fileHash), true, 'a newer submission of the dump is kept');

  recent.set(JOB.fileHash, { uid: failedUid, expiresAt: Date.now() + 60_000 });
  reuse.forget(failed);
  assert.equal(recent.has(JOB.fileHash), false);

  reuse.forget(failed); // nothing to drop
  assert.equal(recent.size, 0);
});

// Issue #330: a reused submission was handed the earlier submission's uid,
// whose signed claims carry that submission's file and archive names.
test('a resubmission gets its own uid for the running upstream job, with its own metadata (issue #330)', () => {
  const codec = createExternalJobCodec({ secret: SECRET, maxAgeMs: 2 * 60 * 60 * 1000 });
  const recent = new Map();
  let clock = Date.parse('2026-10-30T12:00:00Z');
  const reuse = createExternalSubmissionReuse({ recent, codec, now: () => clock });
  const firstUid = codec.issue({ ...JOB, fileName: 'ok.dmp', originalZip: 'first.zip' }, clock);
  recent.set(JOB.fileHash, { uid: firstUid, expiresAt: clock + 15 * 60 * 1000 });

  clock += 60_000;
  const meta = { fileName: 'other.dmp', fileSize: JOB.fileSize, dumpType: 'minidump', originalZip: 'second.7z' };
  const uid = reuse.lookup(JOB.fileHash, meta);
  assert.ok(uid);
  assert.notEqual(uid, firstUid);
  const job = codec.parse(uid, clock);
  assert.equal(job.fileName, 'other.dmp');
  assert.equal(job.originalZip, 'second.7z');
  assert.equal(job.fileHash, JOB.fileHash);
  assert.equal(job.upstreamJobId, JOB.upstreamJobId, 'same upstream job');
  assert.equal(job.acceptedAt, codec.parse(firstUid, clock).acceptedAt, 'same accept time, so the same deadline');

  // A bare dump (no archive) does not inherit the earlier archive name.
  assert.equal(codec.parse(reuse.lookup(JOB.fileHash, { ...meta, originalZip: undefined }), clock).originalZip, undefined);
  // The join path re-issues the uid the running submit returned.
  assert.equal(codec.parse(reuse.reissue(firstUid, meta), clock).fileName, 'other.dmp');

  // Expired or unknown entries are not reused.
  assert.equal(reuse.lookup('ffff', meta), null);
  clock += 15 * 60 * 1000;
  assert.equal(reuse.lookup(JOB.fileHash, meta), null);
});

test('uids minted for one upstream job share one report, one stats row and one corpus row (issue #330)', async () => {
  const codec = createExternalJobCodec({ secret: SECRET });
  const recent = new Map();
  const reuse = createExternalSubmissionReuse({ recent, codec });
  const { resolver, calls } = harness({ upstream: async () => ({ status: 'done', result: 'kd> !analyze -v' }) });
  const firstUid = codec.issue({ ...JOB, fileName: 'ok.dmp' });
  recent.set(JOB.fileHash, { uid: firstUid, expiresAt: Date.now() + 60_000 });
  const secondUid = reuse.lookup(JOB.fileHash, { fileName: 'other.dmp', fileSize: JOB.fileSize, dumpType: JOB.dumpType });

  const [a, b] = await Promise.all([resolver.resolve(codec.parse(firstUid)), resolver.resolve(codec.parse(secondUid))]);
  assert.equal(a.status, 'completed');
  assert.equal(b, a);
  assert.equal(calls.upstream, 1);
  assert.equal(calls.reports, 1, 'one AI report (one quota charge, one crash-signal row)');
  assert.equal(calls.stats, 1);
  assert.equal(calls.corpus.length, 1);
});

test('forget matches the reuse entry by upstream job, whichever uid the job was polled through (issue #330)', () => {
  const codec = createExternalJobCodec({ secret: SECRET });
  const recent = new Map();
  const reuse = createExternalSubmissionReuse({ recent, codec });
  recent.set(JOB.fileHash, { uid: codec.issue(JOB), expiresAt: Date.now() + 60_000 });
  const reissued = codec.parse(reuse.lookup(JOB.fileHash, { fileName: 'other.dmp', fileSize: 1, dumpType: 'minidump' }));
  reuse.forget(reissued);
  assert.equal(recent.has(JOB.fileHash), false);
});
