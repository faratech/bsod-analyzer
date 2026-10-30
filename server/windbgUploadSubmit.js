// Response budget for the browser upload route's WinDbg-API submit (issue #276).
//
// Cloudflare drops the origin connection at 100 s, and the signed file handle
// that lets the browser poll a job only ships in the /api/windbg/upload
// response. A submit that outlived the edge used to leave the browser with an
// HTML 524 and the upstream job with nobody to poll it. The route now answers
// within `responseBudgetMs` (default 90 s): a slower submit gets a retryable
// JSON 504 while the upstream call keeps running under its own longer timeout.
//
// WinDbg-API has no idempotency key or file-hash dedupe, so a job created
// after the 504 cannot be tied to the browser by the upstream alone. This
// instance remembers it per file hash instead: a retry that arrives while the
// submit is still running joins it, and one that arrives after it finished
// adopts the job (once) instead of submitting the dump again. Both are
// per-instance memory; a retry that lands on another instance submits a fresh
// job and the late one is only logged (onLateResult), not polled.
//
// A submit answered with the timeout no longer holds the route's concurrency
// slot but still holds the dump buffer and its multipart Blob copy, so the
// submitter caps how many submits run at once on this instance, answered or
// not (`maxInFlight`, issue #314): a new dump past the cap gets { outcome:
// 'busy' } without an upstream call, while joining or adopting stays allowed.
//
// A submit that fails ambiguously (`isUnconfirmedFailure`: a gateway 5xx, a
// timeout, a garbled 2xx) may still have created an upstream job that nobody
// can adopt, so the failure is answered non-retryable and the file hash is
// held for `holdMs` (issue #328, 10 minutes at most): a re-run of the same dump on this instance
// within it gets { outcome: 'unconfirmed' } instead of a second submit. A
// late successful result is still adopted first. `holdMs` defaults to
// min(retainMs, 10 minutes); the /api/analyze submitter keeps no results
// (retainMs 0) but passes its own hold (createExternalWinDbgSubmitter, #336).

import { isUnconfirmedSubmitFailure } from './windbgSubmitFailure.js';

// How long a file hash stays held after an ambiguous failure (issue #328). A
// WinDbg-API job finishes or times out in about 7 minutes plus queue time, so
// a hold much longer than this only denies WinDBG analysis of a dump for no
// benefit; the successful-result retention (`retainMs`) stays longer.
export const DEFAULT_UNCONFIRMED_HOLD_MS = 10 * 60 * 1000;

export const CLOUDFLARE_ORIGIN_TIMEOUT_MS = 100_000;
export const DEFAULT_WINDBG_UPLOAD_RESPONSE_BUDGET_MS = 90_000;
export const MAX_WINDBG_UPLOAD_RESPONSE_BUDGET_MS = 95_000;

export function resolveUploadResponseBudgetMs(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_WINDBG_UPLOAD_RESPONSE_BUDGET_MS;
  return Math.min(parsed, MAX_WINDBG_UPLOAD_RESPONSE_BUDGET_MS);
}

export function createWinDbgUploadSubmitter({
  responseBudgetMs = DEFAULT_WINDBG_UPLOAD_RESPONSE_BUDGET_MS,
  retainMs = 30 * 60 * 1000,
  holdMs = Math.min(retainMs, DEFAULT_UNCONFIRMED_HOLD_MS),
  maxEntries = 500,
  maxInFlight = Infinity,
  isUnconfirmedFailure = () => false,
  now = Date.now,
  onLateResult = () => {},
  onLateError = () => {}
} = {}) {
  const inFlight = new Map(); // uid -> { promise, late, waiting }
  const adoptable = new Map(); // uid -> { result, at }
  const unconfirmed = new Map(); // uid -> at

  function isHeld(uid) {
    const at = unconfirmed.get(uid);
    if (at === undefined) return false;
    if (now() - at <= holdMs) return true;
    unconfirmed.delete(uid);
    return false;
  }

  // Milliseconds until a held file hash is released; 0 when it is not held.
  function holdRemainingMs(uid) {
    if (!isHeld(uid)) return 0;
    return Math.max(0, holdMs - (now() - unconfirmed.get(uid)));
  }

  function hold(uid, error) {
    if (!(holdMs > 0) || !isUnconfirmedFailure(error)) return;
    unconfirmed.delete(uid);
    unconfirmed.set(uid, now());
    while (unconfirmed.size > maxEntries) {
      unconfirmed.delete(unconfirmed.keys().next().value);
    }
  }

  function takeAdoptable(uid) {
    const entry = adoptable.get(uid);
    if (!entry) return null;
    adoptable.delete(uid);
    return now() - entry.at <= retainMs ? entry.result : null;
  }

  function hasAdoptable(uid) {
    const entry = adoptable.get(uid);
    return Boolean(entry) && now() - entry.at <= retainMs;
  }

  // Whether a request for `uid` (null when unknown) could get past the cap
  // right now: below it, or joining/adopting its own submit (issue #338).
  function admits(uid) {
    if (inFlight.size < maxInFlight) return true;
    return Boolean(uid) && (inFlight.has(uid) || hasAdoptable(uid));
  }

  function remember(uid, result) {
    if (!(retainMs > 0)) return; // the caller keeps its own reuse record
    adoptable.delete(uid);
    adoptable.set(uid, { result, at: now() });
    while (adoptable.size > maxEntries) {
      adoptable.delete(adoptable.keys().next().value);
    }
  }

  // `owed` counts requests answered with the timeout that have not had the
  // job since: each timeout adds one, and a request that joins after a
  // timeout takes one (it is most likely that requester's retry). A result
  // that settles while any is owed is kept for adoption even when another
  // waiter received it (issue #337), so the timed-out requester's retry
  // adopts the job instead of submitting the dump again.
  function start(uid, startSubmit) {
    const entry = { late: false, waiting: 0, owed: 0 };
    entry.promise = Promise.resolve().then(startSubmit);
    inFlight.set(uid, entry);
    // The place in the cap is held until the submit settles, on every path.
    const release = () => {
      if (inFlight.get(uid) === entry) inFlight.delete(uid);
    };
    entry.promise.then(
      result => {
        release();
        // A requester answered with the timeout may come back: keep it for
        // the retry (#337). Only log it when nobody received it at all.
        if (entry.owed > 0) remember(uid, result);
        if (entry.late && entry.waiting === 0) onLateResult(uid, result);
      },
      error => {
        release();
        hold(uid, error);
        if (entry.late && entry.waiting === 0) onLateError(uid, error);
      }
    );
    return entry;
  }

  // Resolves { outcome: 'submitted', result, reused }, { outcome: 'timeout' },
  // { outcome: 'busy' } (cap reached, nothing submitted) or { outcome:
  // 'unconfirmed' } (an earlier submit of this dump failed ambiguously, nothing
  // submitted); rejects when the submit fails within the budget.
  async function submitWithinBudget(uid, startSubmit) {
    const adopted = takeAdoptable(uid);
    if (adopted) return { outcome: 'submitted', result: adopted, reused: true };

    let entry = inFlight.get(uid);
    const reused = Boolean(entry);
    if (entry && entry.owed > 0) entry.owed -= 1;
    if (!entry) {
      if (isHeld(uid)) return { outcome: 'unconfirmed' };
      if (inFlight.size >= maxInFlight) return { outcome: 'busy' };
      entry = start(uid, startSubmit);
    }

    entry.waiting += 1;
    let timer;
    const budget = new Promise(resolve => {
      timer = setTimeout(() => {
        entry.waiting -= 1;
        entry.late = true;
        entry.owed += 1;
        resolve({ outcome: 'timeout' });
      }, responseBudgetMs);
    });
    try {
      return await Promise.race([
        entry.promise.then(result => ({ outcome: 'submitted', result, reused })),
        budget
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  return { submitWithinBudget, holdRemainingMs, admits, inFlight: () => inFlight.size };
}

const FILE_HASH_RE = /^[a-f0-9]{64}$/i;

// Route middleware for /api/windbg/upload (issue #338): the submit cap used to
// answer 429 only from the handler, after the whole dump (up to 100 MB) was
// buffered, validated and hashed, so a refused upload cost the full transfer
// and an upload-limiter slot. This runs before the limiters and the body
// parser. The dump's hash is only known after the body, so a retry that would
// join or adopt its own running submit (#276, #314) is recognised by the
// browser's advisory X-File-Hash header; a request without one (an old
// bundle) is refused at the cap. The header only decides whether the body is
// read: the handler hashes the body itself and the submitter re-checks the cap
// with that hash, so a wrong or forged header gets the old post-body refusal.
export function createWinDbgUploadCapGate({ submitter, retryAfterSeconds = 15 }) {
  return (req, res, next) => {
    const hint = req.headers?.['x-file-hash'];
    const uid = typeof hint === 'string' && FILE_HASH_RE.test(hint) ? hint.toLowerCase() : null;
    if (submitter.admits(uid)) return next();
    res.set('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({
      success: false,
      error: 'Server is busy. Please retry shortly.',
      code: 'WINDBG_UPLOAD_BUSY'
    });
  };
}

// The /api/analyze submitter (issues #315, #336). retainMs 0: `recent` (see
// createExternalWinDbgSubmit) is its only reuse record. An ambiguous submit
// failure, within the budget or after the timeout answer, still holds the file
// hash for DEFAULT_UNCONFIRMED_HOLD_MS so the forum worker's resubmission gets
// { outcome: 'unconfirmed' } instead of queuing a second upstream job. Like
// join/adopt the hold is per-instance memory: a resubmission that lands on
// another instance submits again.
export function createExternalWinDbgSubmitter(options = {}) {
  return createWinDbgUploadSubmitter({
    ...options,
    retainMs: 0,
    holdMs: DEFAULT_UNCONFIRMED_HOLD_MS,
    isUnconfirmedFailure: isUnconfirmedSubmitFailure
  });
}

// /api/analyze hand-off (issue #315). The external route used to await the
// submit for up to 240 s behind Cloudflare's 100 s and wrote its reuse entry
// (fileHash -> signed uid) only afterwards, so a worker resubmitting after the
// edge cut the request started a second upstream job. Here the submit is
// registered under the file hash before it is awaited (a resubmission joins
// it), the answer comes within the submitter's budget, and the uid is
// recorded in `recent` when the submit settles, even after the timeout
// answer, so the next resubmission is handed that job. Build the submitter
// with createExternalWinDbgSubmitter (retainMs: 0): `recent` is the only
// reuse record, so dropping an entry (a degraded report, #256) means a fresh
// run.
//
// startSubmit resolves { uid, upstreamJobId }. Resolves the submitter's
// outcome ({ outcome: 'submitted', result, reused } | timeout | busy |
// unconfirmed).
export function createExternalWinDbgSubmit({ submitter, recent, ttlMs, now = Date.now }) {
  return function submitExternal(fileHash, startSubmit) {
    return submitter.submitWithinBudget(fileHash, async () => {
      const result = await startSubmit();
      recent.set(fileHash, { uid: result.uid, expiresAt: now() + ttlMs });
      return result;
    });
  };
}
