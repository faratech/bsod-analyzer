// Stateless external analyze jobs (POST /api/analyze + GET /api/analyze/status/:uid).
//
// The job id handed to API clients is a signed token carrying everything a
// status poll needs — the file hash, the upstream WinDBG job id, the accept
// time and the file metadata — so any Cloud Run instance can answer a poll by
// asking the upstream WinDBG service directly. Nothing is stored in Redis;
// completed results are memoized per instance and the analysis cache
// (Upstash, when available) short-circuits repeat work.
import { createSigner } from './sessionToken.js';
import { classifyWinDbgSubmitFailure, INSUFFICIENT_STORAGE_STATUS, RETRY_LATER_STATUS } from './windbgSubmitFailure.js';

const UID_PREFIX = 'APIv2.';
// Names ride in the uid (a URL path segment; the router allows 1024 chars).
const MAX_NAME_LENGTH = 120;
const FAILED_MESSAGE = 'Analysis failed. Please ensure the uploaded file is a valid Windows crash dump.';

// A status-poll 4xx from the upstream (other than the try-again-later ones,
// server/windbgSubmitFailure.js) will never succeed.
export function isPermanentUpstreamError(error) {
  const status = Number(error?.upstreamStatus);
  return Number.isInteger(status) && status >= 400 && status < 500 && !RETRY_LATER_STATUS.has(status);
}

// /api/analyze response when handing the dump to WinDBG failed (#269, #327),
// classified like the browser upload route: an upstream refusal of the file
// itself is a non-retryable 422, a "try again later" status a 503 with
// Retry-After, a 429 that will not clear within seconds a non-retryable 503
// ANALYSIS_LIMITED (#340), an unconfirmed upstream outcome a 502 (#334), everything else
// (upstream auth/proxy refusals, local failures) stays a retryable 500.
export function analyzeSubmitFailureResponse(error, processingTime) {
  const failure = classifyWinDbgSubmitFailure(error);
  if (failure.kind === 'rejected') {
    return {
      status: 422,
      body: {
        success: false,
        error: 'The analysis service rejected this file. Please ensure it is a supported Windows crash dump (a minidump or a 64-bit kernel dump).',
        code: 'DUMP_REJECTED',
        upstreamStatus: failure.upstreamStatus,
        processingTime
      }
    };
  }
  if (failure.kind === 'limited') {
    // A per-key quota or a long Retry-After (issue #340): a retry within
    // seconds is refused again; the upstream's Retry-After says when to come
    // back, when it sent one.
    return {
      status: 503,
      ...(failure.retryAfterSeconds == null ? {} : { headers: { 'Retry-After': String(failure.retryAfterSeconds) } }),
      body: {
        success: false,
        error: 'The analysis service has reached its submission limit for now. Please try again later.',
        code: 'ANALYSIS_LIMITED',
        retryable: false,
        processingTime
      }
    };
  }
  if (failure.kind === 'retry_later' || failure.kind === 'unreachable') {
    return {
      status: 503,
      headers: { 'Retry-After': String(failure.retryAfterSeconds) },
      body: {
        success: false,
        error: failure.upstreamStatus === INSUFFICIENT_STORAGE_STATUS
          ? 'The analysis service is temporarily out of space. Please try again in a few minutes.'
          : 'The analysis service is busy. Please try again shortly.',
        code: 'ANALYSIS_RETRY_LATER',
        retryable: true,
        processingTime
      }
    };
  }
  if (failure.kind === 'unconfirmed') {
    // WinDbg-API answered without confirming a job (a 202 without job id, a
    // garbled 2xx, a 5xx) or the connection was lost mid-request: an upstream
    // failure, not a local one (#334).
    return {
      status: 502,
      body: {
        success: false,
        error: 'The analysis service did not confirm the submission. Please try again later.',
        code: 'ANALYSIS_INIT_FAILED',
        // It may still be processing the dump: an immediate resubmission is
        // held on this instance (409 ANALYSIS_PENDING, #336).
        retryable: false,
        processingTime
      }
    };
  }
  return {
    status: 500,
    body: {
      success: false,
      error: 'An internal error occurred while initiating the analysis. Please try again later.',
      code: 'ANALYSIS_INIT_FAILED',
      processingTime
    }
  };
}

// A resubmission of a dump whose earlier submit failed ambiguously on this
// instance (issue #336): WinDbg-API may still be processing it, so nothing was
// submitted. Retry-After is the rest of the hold; after it a resubmission
// submits afresh.
export function analyzeHeldSubmissionResponse(holdRemainingMs, processingTime) {
  return {
    status: 409,
    headers: { 'Retry-After': String(Math.max(1, Math.ceil(holdRemainingMs / 1000))) },
    body: {
      success: false,
      error: 'This dump was sent to the analysis service recently and may still be processing there, so it was not sent again. Please try again later.',
      code: 'ANALYSIS_PENDING',
      retryable: false,
      processingTime
    }
  };
}

const CLOCK_SKEW_MS = 60 * 1000;

// maxAgeMs bounds how long a uid answers status polls (issue #136): without it
// a uid for a completed job stayed usable until SESSION_SECRET rotated.
export function createExternalJobCodec({ secret, previousSecret, maxAgeMs = Infinity }) {
  const signer = createSigner({ secret, previousSecret, purpose: 'external-job-v1' });
  return {
    // job: { fileHash, upstreamJobId, fileName, fileSize, dumpType, originalZip }
    issue(job, now = Date.now()) {
      const claims = {
        v: 1,
        fh: job.fileHash,
        iat: now,
        fn: String(job.fileName ?? '').slice(0, MAX_NAME_LENGTH),
        fs: job.fileSize,
        dt: job.dumpType
      };
      if (job.upstreamJobId) claims.jid = String(job.upstreamJobId);
      if (job.originalZip) claims.oz = String(job.originalZip).slice(0, MAX_NAME_LENGTH);
      return UID_PREFIX + signer.sign(claims);
    },

    // Returns the job, or null for anything not issued by this service or
    // older than maxAgeMs.
    parse(uid, now = Date.now()) {
      if (typeof uid !== 'string' || !uid.startsWith(UID_PREFIX)) return null;
      const claims = signer.verify(uid.slice(UID_PREFIX.length));
      if (!claims || claims.v !== 1 || typeof claims.fh !== 'string' || !Number.isFinite(claims.iat)) return null;
      if (claims.iat > now + CLOCK_SKEW_MS || now - claims.iat > maxAgeMs) return null;
      return {
        uid,
        fileHash: claims.fh,
        upstreamJobId: claims.jid || null,
        acceptedAt: claims.iat,
        fileName: claims.fn,
        fileSize: claims.fs,
        dumpType: claims.dt,
        originalZip: claims.oz || undefined
      };
    }
  };
}

export function isExternalJobUid(uid) {
  return typeof uid === 'string' && uid.startsWith(UID_PREFIX);
}

// Upstream job failures caused by the dump itself: cdb could not analyze it,
// or WinDbg-API could not read the upload. Submitting it again fails the same
// way, so such a failure keeps handing its uid to resubmissions.
const DUMP_FAILURE_CATEGORIES = new Set(['cdb', 'upload']);

// True when a new submission of the dump may succeed where this job failed
// (issue #329): the upstream job failed for a server-side reason (worker,
// watchdog, timeout, storage, or no category), the status poll got a
// permanent 4xx (the job is gone), the deadline passed, the completed job
// carried no analysis text, or a cache-hit job's cache entry is gone.
export function isResubmittableFailure(category, detail) {
  if (category === 'upstream_failed') return !DUMP_FAILURE_CATEGORIES.has(detail);
  return true;
}

// The per-instance map of recent /api/analyze submissions (fileHash ->
// { uid, expiresAt }) that hands a resubmission of a dump the job already
// running for it.
export function createExternalSubmissionReuse({ recent, codec, now = Date.now }) {
  function entryJob(fileHash) {
    const entry = recent.get(fileHash);
    if (!entry) return null;
    return codec.parse(entry.uid, now());
  }

  // A uid for the same upstream job (same file hash, upstream job id and
  // accept time, so the same deadline and one shared resolution) carrying
  // this submission's own file metadata (issue #330).
  function reissue(uid, { fileName, fileSize, dumpType, originalZip }) {
    const prior = codec.parse(uid, now());
    if (!prior) return null;
    return codec.issue({
      fileHash: prior.fileHash,
      upstreamJobId: prior.upstreamJobId,
      fileName,
      fileSize,
      dumpType,
      originalZip
    }, prior.acceptedAt);
  }

  return {
    reissue,

    // The uid for a resubmission of fileHash while its earlier submission's
    // job is still recent, or null.
    lookup(fileHash, meta) {
      const entry = recent.get(fileHash);
      if (!entry || entry.expiresAt <= now()) return null;
      return reissue(entry.uid, meta);
    },

    // Drops the entry for job's dump while it still points at job's upstream
    // job (a newer submission of the dump keeps its own entry).
    forget(job) {
      if (!recent.has(job.fileHash)) return;
      const current = entryJob(job.fileHash);
      if (!current || (current.upstreamJobId || null) === (job.upstreamJobId || null)) {
        recent.delete(job.fileHash);
      }
    }
  };
}

export function createExternalJobResolver({
  getUpstreamJob,
  mapUpstreamStatus,
  extractAnalysis,
  loadCachedAnalysis,
  cacheAnalysis,
  generateReport,
  recordStats = () => {},
  recordCorpus = () => {},
  // Best-effort extras for a completed report (related forum threads); a
  // failure yields [] and never fails the job.
  findRelated = async () => [],
  // Called when a degraded (aiAvailable:false) report is finalized at the
  // deadline, so the caller can stop handing the uid to resubmissions.
  onDegraded = () => {},
  // Called once when a job fails in a way a fresh submission may fix
  // (isResubmittableFailure), so the caller can stop handing the uid to
  // resubmissions of the dump (issue #329). Pollers of the uid still get the
  // failure.
  onFailed = () => {},
  deadlineMs = 15 * 60 * 1000,
  resultTtlMs = 2 * 60 * 60 * 1000,
  // How often a degraded report's AI step is retried, and how long a degraded
  // result finalized at the deadline stays memoized (issue #256).
  degradedRetryMs = 60 * 1000,
  now = () => Date.now(),
  logger = console
}) {
  // Keyed by what the job is (file hash + upstream job), never by the uid
  // text, so equivalent uids share one resolution (issue #136).
  const results = new Map(); // jobKey -> { result, expiresAt }
  const inFlight = new Map(); // jobKey -> Promise<result>
  // Analysis whose report came back degraded, kept so a retry re-runs only the
  // AI step (stats and corpus are recorded once): jobKey -> { analysis, retryAt, expiresAt }
  const degradedRetries = new Map();
  const jobKey = job => `${job.fileHash}\u0000${job.upstreamJobId || ''}`;

  function completed(job, report, relatedThreads = []) {
    return { status: 'completed', report, relatedThreads, processingTime: Math.max(0, (now() - job.acceptedAt) / 1000) };
  }

  function failed(job, category, detail) {
    logger.warn?.('analyze.failed', { uid: job.uid.slice(0, 24), category, detail });
    if (isResubmittableFailure(category, detail)) {
      try {
        onFailed(job, category);
      } catch (error) {
        logger.warn?.('analyze.on_failed_error', { detail: error?.message || String(error) });
      }
    }
    return { status: 'failed', error: FAILED_MESSAGE };
  }

  async function reportFrom(job, analysis, context) {
    const report = await generateReport(job, analysis, context);
    const key = jobKey(job);
    if (report?.aiAvailable === false) {
      // A transient AI failure (issue #256): keep the job processing and retry
      // the AI step on a later poll; only the deadline finalizes the degraded
      // report.
      if (now() - job.acceptedAt < deadlineMs) {
        degradedRetries.set(key, {
          analysis,
          retryAt: now() + degradedRetryMs,
          expiresAt: job.acceptedAt + deadlineMs
        });
        logger.warn?.('analyze.report_degraded', { uid: job.uid.slice(0, 24), retryInMs: degradedRetryMs });
        return { status: 'processing' };
      }
      onDegraded(job);
    }
    degradedRetries.delete(key);
    let relatedThreads = [];
    try {
      const found = await findRelated(job, analysis, report);
      if (Array.isArray(found)) relatedThreads = found;
    } catch (error) {
      logger.warn?.('analyze.related_failed', { uid: job.uid.slice(0, 24), detail: error?.message || String(error) });
    }
    return completed(job, report, relatedThreads);
  }

  async function advance(job, context) {
    const retry = degradedRetries.get(jobKey(job));
    if (retry) {
      if (now() < retry.retryAt && now() - job.acceptedAt < deadlineMs) return { status: 'processing' };
      return await reportFrom(job, retry.analysis, context);
    }

    const cached = await loadCachedAnalysis(job.fileHash);
    if (cached?.windbgOutput) return await reportFrom(job, cached, context);

    if (!job.upstreamJobId) {
      // Accepted from a cache hit whose entry has since expired or become
      // unreachable; there is no upstream job to fall back on. A transient
      // cache miss must not terminally fail the job (issue #174): keep
      // polling until the deadline, then fail.
      if (now() - job.acceptedAt >= deadlineMs) return failed(job, 'cached_result_unavailable');
      return { status: 'processing' };
    }

    let upstream;
    try {
      upstream = await getUpstreamJob(job.upstreamJobId);
    } catch (error) {
      if (isPermanentUpstreamError(error)) return failed(job, 'permanent_upstream_error', error.message);
      if (now() - job.acceptedAt >= deadlineMs) return failed(job, 'deadline_exceeded', error.message);
      throw error; // transient: the client's next poll retries
    }

    const status = mapUpstreamStatus(upstream?.status);
    if (status === 'failed') return failed(job, 'upstream_failed', upstream?.error_category || null);
    if (status !== 'completed') {
      if (now() - job.acceptedAt >= deadlineMs) return failed(job, 'deadline_exceeded');
      return { status: 'processing' };
    }

    const analysis = extractAnalysis(upstream);
    if (!analysis?.analysisText) return failed(job, 'empty_analysis');
    await cacheAnalysis(job.fileHash, analysis);
    recordStats(job, analysis);
    recordCorpus(job, upstream);
    return await reportFrom(job, {
      windbgOutput: analysis.analysisText,
      analysisSignalText: analysis.analysisSignalText,
      structured: analysis.structured
    }, context);
  }

  // Resolves a parsed job to { status: 'processing' } | { status: 'failed', error }
  // | { status: 'completed', report, relatedThreads, processingTime }. Terminal results are
  // memoized; concurrent polls for one uid share a single resolution.
  // `context` (the poll's AI deadline, issue #305) is passed to generateReport;
  // a poll that joins an in-flight resolution shares the first poll's.
  async function resolve(job, context = {}) {
    const key = jobKey(job);
    const memo = results.get(key);
    if (memo && memo.expiresAt > now()) return memo.result;
    let pending = inFlight.get(key);
    if (!pending) {
      pending = advance(job, context)
        .then(result => {
          // A cache-hit job (no upstream job) shares its key with the next
          // cache-hit uid for the dump, so its failure is not memoized: the
          // old uid fails again on its own deadline (issue #329).
          const keyShared = result.status === 'failed' && !job.upstreamJobId;
          if (result.status !== 'processing' && !keyShared) {
            // A degraded report is memoized briefly, so a poll after the
            // provider recovers regenerates it (issue #256).
            const degraded = result.status === 'completed' && result.report?.aiAvailable === false;
            results.set(key, { result, expiresAt: now() + (degraded ? degradedRetryMs : resultTtlMs) });
          }
          return result;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    return pending;
  }

  function prune(at = now()) {
    for (const [key, memo] of results) {
      if (memo.expiresAt <= at) results.delete(key);
    }
    for (const [key, retry] of degradedRetries) {
      if (retry.expiresAt + degradedRetryMs <= at) degradedRetries.delete(key);
    }
  }

  return { resolve, prune };
}
