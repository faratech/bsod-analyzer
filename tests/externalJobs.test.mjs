import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createExternalJobCodec,
  createExternalJobResolver,
  isExternalJobUid,
  isPermanentUpstreamError
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

function harness({ cached = null, upstream = async () => ({ status: 'running' }), now = () => Date.now() } = {}) {
  const calls = { upstream: 0, reports: 0, cached: [], stats: 0 };
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
  assert.equal(isPermanentUpstreamError(new Error('network')), false);
});

test('a cache-hit job whose cache entry is gone fails instead of polling forever', async () => {
  const codec = createExternalJobCodec({ secret: SECRET });
  const job = codec.parse(codec.issue({ ...JOB, upstreamJobId: undefined }));
  const { resolver, calls } = harness();
  assert.equal((await resolver.resolve(job)).status, 'failed');
  assert.equal(calls.upstream, 0);
});
