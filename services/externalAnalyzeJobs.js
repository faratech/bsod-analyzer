import { mapWinDbgJobStatus } from '../shared/windbgApiClient.js';

const PROCESSING_PHASES = new Set(['polling', 'downloading', 'reporting']);
const RETRYABLE_UPSTREAM_STATUS = new Set([408, 409, 425, 429, 502, 503, 504, 520, 522, 524, 525]);
const DEFAULT_JOB_DEADLINE_MS = 15 * 60 * 1000;
const DEFAULT_MAX_PHASE_ATTEMPTS = 6;

class ExternalAnalyzeLeaseLostError extends Error {
  constructor() {
    super('External analysis job lease was lost');
    this.name = 'ExternalAnalyzeLeaseLostError';
    this.code = 'ANALYSIS_LEASE_LOST';
  }
}

class ExternalAnalyzeCheckpointError extends Error {
  constructor(message, { cause, upstreamJobId } = {}) {
    super(message, { cause });
    this.name = 'ExternalAnalyzeCheckpointError';
    this.code = 'ANALYSIS_CHECKPOINT_FAILED';
    this.upstreamJobId = upstreamJobId;
  }
}

function terminalJob(job) {
  return job?.status === 'completed' || job?.status === 'failed';
}

function upstreamFailureMessage(upstream) {
  const value = upstream?.error || upstream?.error_message || upstream?.message;
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : null;
}

function errorMessage(error) {
  const value = error?.message || String(error || 'Unknown analysis error');
  return String(value).trim().slice(0, 500);
}

function isPermanentPhaseError(error) {
  const status = Number(error?.upstreamStatus);
  return Number.isInteger(status)
    && status >= 400
    && status < 500
    && !RETRYABLE_UPSTREAM_STATUS.has(status);
}

async function handoffExternalAnalyzeJob({ uploadDump, persistJob, createJob }) {
  for (const [name, value] of Object.entries({ uploadDump, persistJob, createJob })) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  }

  const uploadResult = await uploadDump();
  if (!uploadResult?.success || typeof uploadResult.jobId !== 'string' || !uploadResult.jobId) {
    throw new Error(uploadResult?.error || 'WinDBG upload failed');
  }

  const upstreamJobId = uploadResult.jobId;
  const job = createJob({ upstreamJobId, uploadResult });
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    throw new TypeError('createJob must return a job object');
  }

  try {
    const persisted = await persistJob(job);
    if (persisted === false) throw new Error('Analysis job checkpoint was rejected');
  } catch (error) {
    throw new ExternalAnalyzeCheckpointError(
      'WinDBG accepted the dump but the analysis job could not be checkpointed',
      { cause: error, upstreamJobId }
    );
  }

  return { job, upstreamJobId, uploadResult };
}

function createExternalAnalyzeJobCoordinator({
  loadJob,
  storeLeasedJob,
  acquireLease,
  renewLease,
  releaseLease,
  getUpstreamJob,
  downloadAnalysis,
  cacheAnalysis,
  loadCachedAnalysis,
  generateReport,
  recordWinDbgStats = () => {},
  now = Date.now,
  leaseRefreshMs = 30_000,
  jobDeadlineMs = DEFAULT_JOB_DEADLINE_MS,
  maxPhaseAttempts = DEFAULT_MAX_PHASE_ATTEMPTS,
  logger = console
}) {
  const required = {
    loadJob,
    storeLeasedJob,
    acquireLease,
    renewLease,
    releaseLease,
    getUpstreamJob,
    downloadAnalysis,
    cacheAnalysis,
    loadCachedAnalysis,
    generateReport
  };
  for (const [name, value] of Object.entries(required)) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  }
  if (!Number.isFinite(jobDeadlineMs) || jobDeadlineMs <= 0) {
    throw new TypeError('jobDeadlineMs must be a positive number');
  }
  if (!Number.isInteger(maxPhaseAttempts) || maxPhaseAttempts <= 0) {
    throw new TypeError('maxPhaseAttempts must be a positive integer');
  }

  async function advance(uid) {
    const initialJob = await loadJob(uid);
    if (!initialJob || terminalJob(initialJob)) {
      return { job: initialJob, leaseAcquired: false, advanced: false };
    }

    // Jobs accepted by an older revision have no durable upstream ID. Leave
    // them untouched so their originating revision can finish during rollout.
    if (!initialJob.upstreamJobId) {
      return { job: initialJob, leaseAcquired: false, advanced: false, legacy: true };
    }

    const leaseToken = await acquireLease(uid);
    if (!leaseToken) {
      return {
        job: await loadJob(uid),
        leaseAcquired: false,
        advanced: false
      };
    }

    let leaseLost = false;
    let renewalInFlight = null;
    const refreshLease = () => {
      if (renewalInFlight || leaseLost) return;
      renewalInFlight = Promise.resolve(renewLease(uid, leaseToken))
        .then(renewed => {
          if (!renewed) leaseLost = true;
        })
        .catch(error => {
          leaseLost = true;
          logger.warn?.('analyze.lease.renew_failed', {
            uid,
            message: error?.message || String(error)
          });
        })
        .finally(() => {
          renewalInFlight = null;
        });
    };
    const refreshTimer = leaseRefreshMs > 0
      ? setInterval(refreshLease, leaseRefreshMs)
      : null;
    refreshTimer?.unref?.();

    const checkpoint = async (job) => {
      if (leaseLost) throw new ExternalAnalyzeLeaseLostError();
      const expectedVersion = Number.isInteger(job.version) && job.version >= 0
        ? job.version
        : 0;
      const checkpointed = {
        ...job,
        schemaVersion: 2,
        version: expectedVersion + 1,
        timestamp: now()
      };
      const saved = await storeLeasedJob(uid, checkpointed, leaseToken, expectedVersion);
      if (!saved) {
        leaseLost = true;
        throw new ExternalAnalyzeLeaseLostError();
      }
      return checkpointed;
    };

    try {
      let job = await loadJob(uid);
      if (!job || terminalJob(job)) {
        return { job, leaseAcquired: true, advanced: false };
      }
      if (!job.upstreamJobId) {
        return { job, leaseAcquired: true, advanced: false, legacy: true };
      }

      const phase = PROCESSING_PHASES.has(job.phase) ? job.phase : 'polling';
      const baseTime = Number(job.acceptedAt || job.startedAt || job.createdAt || job.timestamp);
      const configuredDeadline = Number(job.deadlineAt);
      const deadlineAt = Number.isFinite(configuredDeadline) && configuredDeadline > 0
        ? configuredDeadline
        : (Number.isFinite(baseTime) ? baseTime + jobDeadlineMs : now() + jobDeadlineMs);
      if (job.deadlineAt !== deadlineAt) job = { ...job, deadlineAt };

      const checkpointPhaseError = async (error) => {
        if (error instanceof ExternalAnalyzeLeaseLostError) throw error;
        const previousAttempts = Number(job.phaseAttempts?.[phase]);
        const attempts = Number.isInteger(previousAttempts) && previousAttempts >= 0
          ? previousAttempts + 1
          : 1;
        const checkedAt = now();
        const permanent = isPermanentPhaseError(error);
        const deadlineExceeded = checkedAt >= deadlineAt;
        const exhausted = attempts >= maxPhaseAttempts;
        const failed = permanent || deadlineExceeded || exhausted;
        job = {
          ...job,
          status: failed ? 'failed' : 'processing',
          phase: failed ? 'failed' : phase,
          phaseAttempts: {
            ...(job.phaseAttempts || {}),
            [phase]: attempts
          },
          lastError: errorMessage(error),
          lastErrorAt: checkedAt,
          lastErrorPhase: phase,
          ...(failed ? {
            error: 'Analysis failed. Please ensure the uploaded file is a valid Windows crash dump.',
            failureCategory: permanent
              ? 'permanent_upstream_error'
              : (deadlineExceeded ? 'deadline_exceeded' : 'phase_retries_exhausted'),
            failedAt: checkedAt
          } : {})
        };
        job = await checkpoint(job);
        logger.warn?.('analyze.phase.error', {
          uid,
          phase,
          attempts,
          terminal: failed,
          category: job.failureCategory || 'retryable',
          message: job.lastError
        });
        return { job, leaseAcquired: true, advanced: true, retryable: !failed };
      };

      if (now() >= deadlineAt) {
        return await checkpointPhaseError(new Error('External analysis job exceeded its deadline'));
      }

      if (phase === 'polling') {
        let upstream;
        try {
          upstream = await getUpstreamJob(job.upstreamJobId);
        } catch (error) {
          return await checkpointPhaseError(error);
        }
        const upstreamStatus = mapWinDbgJobStatus(upstream?.status);
        const upstreamStatusRaw = typeof upstream?.status === 'string' ? upstream.status : null;

        if (upstreamStatus === 'failed') {
          job = {
            ...job,
            status: 'failed',
            phase: 'failed',
            error: 'Analysis failed. Please ensure the uploaded file is a valid Windows crash dump.',
            upstreamStatus: upstreamStatusRaw,
            upstreamError: upstreamFailureMessage(upstream),
            upstreamErrorCategory: upstream?.error_category || null
          };
          job = await checkpoint(job);
          return { job, leaseAcquired: true, advanced: true };
        }

        job = {
          ...job,
          status: 'processing',
          phase: upstreamStatus === 'completed' ? 'downloading' : 'polling',
          upstreamStatus: upstreamStatusRaw,
          lastPolledAt: now(),
          phaseAttempts: {
            ...(job.phaseAttempts || {}),
            [phase]: 0
          },
          lastError: null,
          lastErrorAt: null,
          lastErrorPhase: null
        };
        job = await checkpoint(job);
        return { job, leaseAcquired: true, advanced: true };
      }

      if (phase === 'downloading') {
        let analysis;
        try {
          analysis = await downloadAnalysis(job.upstreamJobId);
          const cached = await cacheAnalysis(job.fileHash, analysis);
          if (!cached) {
            throw new Error('WinDBG analysis could not be checkpointed');
          }
        } catch (error) {
          return await checkpointPhaseError(error);
        }

        job = {
          ...job,
          status: 'processing',
          phase: 'reporting',
          upstreamStatus: 'completed',
          winDbgCachedAt: now(),
          phaseAttempts: {
            ...(job.phaseAttempts || {}),
            [phase]: 0
          },
          lastError: null,
          lastErrorAt: null,
          lastErrorPhase: null
        };
        job = await checkpoint(job);
        return { job, leaseAcquired: true, advanced: true };
      }

      let cachedAnalysis;
      try {
        cachedAnalysis = await loadCachedAnalysis(job.fileHash);
      } catch (error) {
        return await checkpointPhaseError(error);
      }
      if (!cachedAnalysis?.windbgOutput) {
        // The analysis cache is disposable. If it was flushed between phases,
        // rewind to the idempotent upstream download instead of losing the job.
        job = {
          ...job,
          status: 'processing',
          phase: 'downloading',
          winDbgCachedAt: null
        };
        job = await checkpoint(job);
        return { job, leaseAcquired: true, advanced: true };
      }

      let report;
      try {
        report = await generateReport(job, cachedAnalysis);
      } catch (error) {
        return await checkpointPhaseError(error);
      }
      const completedAt = now();
      const startedAt = Number(job.startedAt || job.createdAt || job.timestamp);
      const processingTime = Number.isFinite(startedAt)
        ? Math.max(0, (completedAt - startedAt) / 1000)
        : null;
      job = {
        ...job,
        status: 'completed',
        phase: 'completed',
        data: report,
        error: null,
        aiStatus: report?.aiAvailable === false ? 'unavailable' : 'ok',
        processingTime,
        completedAt,
        lastError: null,
        lastErrorAt: null,
        lastErrorPhase: null
      };
      job = await checkpoint(job);
      // Statistics are best-effort and run only after the one successful
      // terminal CAS, so retried download/report phases cannot double-count.
      try {
        recordWinDbgStats(job, {
          analysisText: cachedAnalysis.windbgOutput,
          analysisSignalText: cachedAnalysis.analysisSignalText,
          structured: cachedAnalysis.structured
        });
      } catch (error) {
        logger.warn?.('analyze.stats.failed', {
          uid,
          message: errorMessage(error)
        });
      }
      return { job, leaseAcquired: true, advanced: true };
    } finally {
      if (refreshTimer) clearInterval(refreshTimer);
      if (renewalInFlight) await renewalInFlight.catch(() => {});
      try {
        await releaseLease(uid, leaseToken);
      } catch (error) {
        logger.warn?.('analyze.lease.release_failed', {
          uid,
          message: error?.message || String(error)
        });
      }
    }
  }

  return { advance };
}

export {
  ExternalAnalyzeCheckpointError,
  ExternalAnalyzeLeaseLostError,
  createExternalAnalyzeJobCoordinator,
  handoffExternalAnalyzeJob,
  terminalJob
};
