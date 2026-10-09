// Stateless external analyze jobs (POST /api/analyze + GET /api/analyze/status/:uid).
//
// The job id handed to API clients is a signed token carrying everything a
// status poll needs — the file hash, the upstream WinDBG job id, the accept
// time and the file metadata — so any Cloud Run instance can answer a poll by
// asking the upstream WinDBG service directly. Nothing is stored in Redis;
// completed results are memoized per instance and the analysis cache
// (Upstash, when available) short-circuits repeat work.
import { createSigner } from './sessionToken.js';

const UID_PREFIX = 'APIv2.';
// Names ride in the uid (a URL path segment; the router allows 1024 chars).
const MAX_NAME_LENGTH = 120;
const RETRYABLE_UPSTREAM_STATUS = new Set([408, 409, 425, 429, 502, 503, 504, 520, 522, 524, 525]);
const FAILED_MESSAGE = 'Analysis failed. Please ensure the uploaded file is a valid Windows crash dump.';

// A 4xx from the upstream (other than the retryable ones) will never succeed.
export function isPermanentUpstreamError(error) {
  const status = Number(error?.upstreamStatus);
  return Number.isInteger(status) && status >= 400 && status < 500 && !RETRYABLE_UPSTREAM_STATUS.has(status);
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
  deadlineMs = 15 * 60 * 1000,
  resultTtlMs = 2 * 60 * 60 * 1000,
  now = () => Date.now(),
  logger = console
}) {
  // Keyed by what the job is (file hash + upstream job), never by the uid
  // text, so equivalent uids share one resolution (issue #136).
  const results = new Map(); // jobKey -> { result, expiresAt }
  const inFlight = new Map(); // jobKey -> Promise<result>
  const jobKey = job => `${job.fileHash}\u0000${job.upstreamJobId || ''}`;

  function completed(job, report, relatedThreads = []) {
    return { status: 'completed', report, relatedThreads, processingTime: Math.max(0, (now() - job.acceptedAt) / 1000) };
  }

  function failed(job, category, detail) {
    logger.warn?.('analyze.failed', { uid: job.uid.slice(0, 24), category, detail });
    return { status: 'failed', error: FAILED_MESSAGE };
  }

  async function reportFrom(job, analysis) {
    const report = await generateReport(job, analysis);
    let relatedThreads = [];
    try {
      const found = await findRelated(job, analysis, report);
      if (Array.isArray(found)) relatedThreads = found;
    } catch (error) {
      logger.warn?.('analyze.related_failed', { uid: job.uid.slice(0, 24), detail: error?.message || String(error) });
    }
    return completed(job, report, relatedThreads);
  }

  async function advance(job) {
    const cached = await loadCachedAnalysis(job.fileHash);
    if (cached?.windbgOutput) return await reportFrom(job, cached);

    if (!job.upstreamJobId) {
      // Accepted from a cache hit whose entry has since expired or become
      // unreachable; there is no upstream job to fall back on.
      return failed(job, 'cached_result_unavailable');
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
    });
  }

  // Resolves a parsed job to { status: 'processing' } | { status: 'failed', error }
  // | { status: 'completed', report, relatedThreads, processingTime }. Terminal results are
  // memoized; concurrent polls for one uid share a single resolution.
  async function resolve(job) {
    const key = jobKey(job);
    const memo = results.get(key);
    if (memo && memo.expiresAt > now()) return memo.result;
    let pending = inFlight.get(key);
    if (!pending) {
      pending = advance(job)
        .then(result => {
          if (result.status !== 'processing') {
            results.set(key, { result, expiresAt: now() + resultTtlMs });
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
  }

  return { resolve, prune };
}
