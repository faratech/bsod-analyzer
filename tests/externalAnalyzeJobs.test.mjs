import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExternalAnalyzeCheckpointError,
  ExternalAnalyzeLeaseLostError,
  createExternalAnalyzeJobCoordinator,
  handoffExternalAnalyzeJob
} from '../services/externalAnalyzeJobs.js';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createHarness(initialJob, overrides = {}) {
  const jobs = new Map([[initialJob.uid, clone(initialJob)]]);
  const leases = new Map();
  const analysisCache = new Map();
  const calls = { poll: 0, download: 0, report: 0, stats: 0 };
  let tokenNumber = 0;
  let clock = 1_800_000_000_000;

  const dependencies = {
    loadJob: async uid => clone(jobs.get(uid)),
    storeLeasedJob: async (uid, next, token, expectedVersion) => {
      const current = jobs.get(uid);
      if (leases.get(uid) !== token) return false;
      if (!current || current.version !== expectedVersion) return false;
      if (current.status === 'completed' || current.status === 'failed') return false;
      jobs.set(uid, clone(next));
      return true;
    },
    acquireLease: async uid => {
      if (leases.has(uid)) return null;
      const token = `lease-${++tokenNumber}`;
      leases.set(uid, token);
      return token;
    },
    renewLease: async (uid, token) => leases.get(uid) === token,
    releaseLease: async (uid, token) => {
      if (leases.get(uid) !== token) return false;
      leases.delete(uid);
      return true;
    },
    getUpstreamJob: async () => {
      calls.poll++;
      return { status: 'completed' };
    },
    downloadAnalysis: async () => {
      calls.download++;
      return {
        analysisText: 'MODULE_NAME: example\nFAILURE_BUCKET_ID: EXAMPLE_BUCKET',
        analysisSignalText: '{"schema":"windbg_crash_signal_v1"}',
        structured: { schema: 'windbg_crash_signal_v1' }
      };
    },
    cacheAnalysis: async (fileHash, analysis) => {
      analysisCache.set(fileHash, {
        windbgOutput: analysis.analysisText,
        analysisSignalText: analysis.analysisSignalText,
        structured: analysis.structured
      });
      return true;
    },
    loadCachedAnalysis: async fileHash => clone(analysisCache.get(fileHash)),
    generateReport: async () => {
      calls.report++;
      return {
        summary: 'Completed report',
        probableCause: 'example.sys',
        culprit: 'example.sys',
        recommendations: ['Update example.sys']
      };
    },
    recordWinDbgStats: () => {
      calls.stats++;
    },
    now: () => ++clock,
    leaseRefreshMs: 0,
    logger: { warn() {} },
    ...overrides
  };

  return {
    jobs,
    leases,
    analysisCache,
    calls,
    dependencies,
    createCoordinator: () => createExternalAnalyzeJobCoordinator(dependencies)
  };
}

function processingJob(overrides = {}) {
  return {
    schemaVersion: 2,
    version: 1,
    uid: 'API-1800000000000-abcdef123456',
    status: 'processing',
    phase: 'polling',
    upstreamJobId: 'windbg-job-123',
    fileHash: '0123456789abcdef',
    fileName: 'memory.dmp',
    fileSize: 64 * 1024,
    dumpType: 'minidump',
    analysisMethod: 'windbg',
    data: null,
    error: null,
    startedAt: 1_799_999_990_000,
    timestamp: 1_799_999_990_000,
    ...overrides
  };
}

test('a fresh coordinator resumes every durable phase from upstreamJobId', async () => {
  const initial = processingJob();
  const harness = createHarness(initial);

  const polled = await harness.createCoordinator().advance(initial.uid);
  assert.equal(polled.job.phase, 'downloading');
  assert.equal(polled.job.version, 2);

  // Simulate an instance/revision restart by constructing a completely fresh
  // coordinator over the same durable job and analysis stores.
  const downloaded = await harness.createCoordinator().advance(initial.uid);
  assert.equal(downloaded.job.phase, 'reporting');
  assert.equal(downloaded.job.version, 3);

  const completed = await harness.createCoordinator().advance(initial.uid);
  assert.equal(completed.job.status, 'completed');
  assert.equal(completed.job.phase, 'completed');
  assert.equal(completed.job.version, 4);
  assert.equal(completed.job.data.culprit, 'example.sys');
  assert.equal(completed.job.upstreamJobId, 'windbg-job-123');
  assert.equal(Object.hasOwn(completed.job, 'fileBuffer'), false);
  assert.deepEqual(harness.calls, { poll: 1, download: 1, report: 1, stats: 1 });
});

test('concurrent status polls perform exactly one upstream side effect', async () => {
  const initial = processingJob();
  let releasePoll;
  let announcePoll;
  const pollStarted = new Promise(resolve => { announcePoll = resolve; });
  const pollReleased = new Promise(resolve => { releasePoll = resolve; });
  const harness = createHarness(initial, {
    getUpstreamJob: async () => {
      harness.calls.poll++;
      announcePoll();
      await pollReleased;
      return { status: 'processing' };
    }
  });
  const coordinator = harness.createCoordinator();

  const owner = coordinator.advance(initial.uid);
  await pollStarted;
  const contenders = await Promise.all(
    Array.from({ length: 19 }, () => coordinator.advance(initial.uid))
  );
  assert.equal(contenders.every(result => result.leaseAcquired === false), true);

  releasePoll();
  const ownerResult = await owner;
  assert.equal(ownerResult.leaseAcquired, true);
  assert.equal(ownerResult.job.phase, 'polling');
  assert.equal(harness.calls.poll, 1);
  assert.equal(harness.jobs.get(initial.uid).version, 2);
});

test('pending upstream status remains durably processing', async () => {
  const initial = processingJob();
  const harness = createHarness(initial, {
    getUpstreamJob: async () => {
      harness.calls.poll++;
      return { status: 'queued' };
    }
  });

  const result = await harness.createCoordinator().advance(initial.uid);
  assert.equal(result.job.status, 'processing');
  assert.equal(result.job.phase, 'polling');
  assert.equal(result.job.upstreamStatus, 'queued');
  assert.equal(result.job.version, 2);
  assert.equal(harness.calls.poll, 1);
  assert.equal(harness.calls.download, 0);
  assert.equal(harness.calls.report, 0);
});

test('failed WinDBG evidence checkpoint does not advance to reporting', async () => {
  const initial = processingJob({ phase: 'downloading' });
  const harness = createHarness(initial, {
    cacheAnalysis: async () => false
  });

  const result = await harness.createCoordinator().advance(initial.uid);
  assert.equal(result.job.status, 'processing');
  assert.equal(result.job.phase, 'downloading');
  assert.equal(result.job.phaseAttempts.downloading, 1);
  assert.equal(result.retryable, true);
  assert.equal(harness.calls.download, 1);
  assert.equal(harness.calls.report, 0);
});

test('missing reporting evidence rewinds to durable upstream download', async () => {
  const initial = processingJob({ phase: 'reporting' });
  const harness = createHarness(initial);

  const result = await harness.createCoordinator().advance(initial.uid);
  assert.equal(result.job.status, 'processing');
  assert.equal(result.job.phase, 'downloading');
  assert.equal(result.job.version, 2);
  assert.equal(harness.calls.poll, 0);
  assert.equal(harness.calls.download, 0);
  assert.equal(harness.calls.report, 0);
});

test('terminal and legacy jobs cause no external calls', async () => {
  const completed = processingJob({ status: 'completed', phase: 'completed' });
  const completedHarness = createHarness(completed);
  const terminalResult = await completedHarness.createCoordinator().advance(completed.uid);
  assert.equal(terminalResult.advanced, false);
  assert.deepEqual(completedHarness.calls, { poll: 0, download: 0, report: 0, stats: 0 });

  const legacy = processingJob({ upstreamJobId: undefined, schemaVersion: undefined });
  const legacyHarness = createHarness(legacy);
  const legacyResult = await legacyHarness.createCoordinator().advance(legacy.uid);
  assert.equal(legacyResult.legacy, true);
  assert.equal(legacyResult.job.status, 'processing');
  assert.deepEqual(legacyHarness.calls, { poll: 0, download: 0, report: 0, stats: 0 });
});

test('upstream terminal failure is checkpointed and never calls download or AI', async () => {
  const initial = processingJob();
  const harness = createHarness(initial, {
    getUpstreamJob: async () => {
      harness.calls.poll++;
      return {
        status: 'timed_out',
        error_message: 'cdb exceeded its deadline',
        error_category: 'timeout'
      };
    }
  });

  const result = await harness.createCoordinator().advance(initial.uid);
  assert.equal(result.job.status, 'failed');
  assert.equal(result.job.phase, 'failed');
  assert.equal(result.job.upstreamErrorCategory, 'timeout');
  assert.equal(result.job.upstreamError, 'cdb exceeded its deadline');
  assert.equal(harness.calls.download, 0);
  assert.equal(harness.calls.report, 0);
});

test('lost lease rejects a stale phase checkpoint', async () => {
  const initial = processingJob({ phase: 'reporting' });
  const harness = createHarness(initial);
  harness.analysisCache.set(initial.fileHash, {
    windbgOutput: 'MODULE_NAME: example',
    structured: {}
  });
  harness.dependencies.generateReport = async () => {
    harness.calls.report++;
    harness.leases.set(initial.uid, 'replacement-owner');
    return {
      summary: 'Stale result',
      probableCause: 'stale',
      culprit: 'stale.sys',
      recommendations: ['Ignore']
    };
  };

  await assert.rejects(
    harness.createCoordinator().advance(initial.uid),
    error => error instanceof ExternalAnalyzeLeaseLostError
  );
  assert.equal(harness.jobs.get(initial.uid).status, 'processing');
  assert.equal(harness.jobs.get(initial.uid).version, 1);
  assert.equal(harness.leases.get(initial.uid), 'replacement-owner');
});

test('lease renewal loss during a long report prevents terminal commit', async () => {
  const initial = processingJob({ phase: 'reporting' });
  const harness = createHarness(initial);
  harness.analysisCache.set(initial.fileHash, {
    windbgOutput: 'MODULE_NAME: example',
    structured: {}
  });
  harness.dependencies.leaseRefreshMs = 1;
  harness.dependencies.renewLease = async (uid) => {
    harness.leases.set(uid, 'replacement-owner');
    return false;
  };
  harness.dependencies.generateReport = async () => {
    harness.calls.report++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return {
      summary: 'Late result',
      probableCause: 'late',
      culprit: 'late.sys',
      recommendations: ['Ignore']
    };
  };

  await assert.rejects(
    harness.createCoordinator().advance(initial.uid),
    error => error instanceof ExternalAnalyzeLeaseLostError
  );
  assert.equal(harness.jobs.get(initial.uid).status, 'processing');
  assert.equal(harness.jobs.get(initial.uid).version, 1);
  assert.equal(harness.leases.get(initial.uid), 'replacement-owner');
});

test('permanent upstream HTTP failures checkpoint a terminal job', async () => {
  const initial = processingJob();
  const error = new Error('WinDBG job status failed with status 404');
  error.code = 'WINDBG_UPSTREAM_ERROR';
  error.upstreamStatus = 404;
  const harness = createHarness(initial, {
    getUpstreamJob: async () => {
      harness.calls.poll++;
      throw error;
    }
  });

  const result = await harness.createCoordinator().advance(initial.uid);
  assert.equal(result.job.status, 'failed');
  assert.equal(result.job.phase, 'failed');
  assert.equal(result.job.failureCategory, 'permanent_upstream_error');
  assert.equal(result.retryable, false);
});

test('expired jobs checkpoint failed instead of aging into a missing 404', async () => {
  const initial = processingJob({ deadlineAt: 1 });
  const harness = createHarness(initial);

  const result = await harness.createCoordinator().advance(initial.uid);
  assert.equal(result.job.status, 'failed');
  assert.equal(result.job.failureCategory, 'deadline_exceeded');
  assert.equal(harness.calls.poll, 0);
});

test('handoff resolves only after upstream acceptance and durable checkpoint', async () => {
  const events = [];
  let releaseCheckpoint;
  const checkpointReleased = new Promise(resolve => { releaseCheckpoint = resolve; });
  let resolved = false;

  const handoff = handoffExternalAnalyzeJob({
    uploadDump: async () => {
      events.push('upload');
      return { success: true, jobId: 'windbg-accepted', data: { status: 'queued' } };
    },
    createJob: ({ upstreamJobId }) => {
      events.push('create');
      return { status: 'processing', upstreamJobId };
    },
    persistJob: async () => {
      events.push('persist');
      await checkpointReleased;
    }
  }).then(result => {
    resolved = true;
    return result;
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['upload', 'create', 'persist']);
  assert.equal(resolved, false);
  releaseCheckpoint();
  const result = await handoff;
  assert.equal(resolved, true);
  assert.equal(result.upstreamJobId, 'windbg-accepted');
});

test('handoff exposes accepted upstream ID when the durable checkpoint fails', async () => {
  await assert.rejects(
    handoffExternalAnalyzeJob({
      uploadDump: async () => ({ success: true, jobId: 'windbg-orphan-risk' }),
      createJob: ({ upstreamJobId }) => ({ status: 'processing', upstreamJobId }),
      persistJob: async () => { throw new Error('Redis unavailable'); }
    }),
    error => error instanceof ExternalAnalyzeCheckpointError
      && error.upstreamJobId === 'windbg-orphan-risk'
      && error.cause?.message === 'Redis unavailable'
  );
});

test('a cached AI report can be reused after a terminal CAS failure', async () => {
  const initial = processingJob({ phase: 'reporting' });
  const harness = createHarness(initial);
  harness.analysisCache.set(initial.fileHash, {
    windbgOutput: 'MODULE_NAME: example',
    structured: {}
  });
  let aiCalls = 0;
  let cachedReport = null;
  harness.dependencies.generateReport = async () => {
    harness.calls.report++;
    if (cachedReport) return { ...cachedReport, cached: true };
    aiCalls++;
    cachedReport = {
      summary: 'Cached result',
      probableCause: 'example',
      culprit: 'example.sys',
      recommendations: ['Update']
    };
    return cachedReport;
  };
  const originalStore = harness.dependencies.storeLeasedJob;
  let rejectTerminalOnce = true;
  harness.dependencies.storeLeasedJob = async (...args) => {
    if (args[1]?.status === 'completed' && rejectTerminalOnce) {
      rejectTerminalOnce = false;
      return false;
    }
    return await originalStore(...args);
  };

  await assert.rejects(
    harness.createCoordinator().advance(initial.uid),
    error => error instanceof ExternalAnalyzeLeaseLostError
  );
  const completed = await harness.createCoordinator().advance(initial.uid);
  assert.equal(completed.job.status, 'completed');
  assert.equal(completed.job.data.cached, true);
  assert.equal(aiCalls, 1);
  assert.equal(harness.calls.report, 2);
});
