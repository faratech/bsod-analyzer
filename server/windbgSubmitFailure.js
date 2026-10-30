// One classification of a failed WinDbg-API submit (POST /api/v1/jobs), shared
// by the browser upload route (server/windbgUploadFailure.js) and /api/analyze
// (server/externalJobs.js) so both answer the same upstream status the same
// way (issue #327).
//
// WinDbg-API's own submit answers: 202, 400 (not a dump, bad profile or
// priority), 401 (key), 413 (too large), 429 (queue full, per-key limit) and
// 507 (storage pressure, checked before any job record exists); proxies in
// front of it add 408/409/423/425 and 5xx/52x. Only failures that guarantee
// no job was created are retryable: the submit has no idempotency key.
import { isQuotaRateLimit, ORIGIN_NOT_REACHED_STATUS, parseRetryAfterSeconds, PRE_SEND_NETWORK_CODES } from '../shared/windbgApiClient.js';

// The file itself was refused: sending it again will not help.
export const REJECTED_FILE_STATUS = new Set([400, 413, 415, 422]);
// The upstream did not take the request and says to come back later.
export const RETRY_LATER_STATUS = new Set([408, 409, 423, 425, 429, 507]);
// Upstream auth/proxy failures are our configuration problem, not the file's.
export const SERVER_CONFIG_STATUS = new Set([401, 403, 407]);
export const INSUFFICIENT_STORAGE_STATUS = 507;

const MIN_RETRY_AFTER_SECONDS = 15;
const MAX_RETRY_AFTER_SECONDS = 30;

function upstreamStatusOf(error) {
  if (error?.upstreamStatus == null || error?.code === 'WINDBG_UPSTREAM_INVALID_JSON') return null;
  const status = Number(error.upstreamStatus);
  return Number.isInteger(status) ? status : null;
}

// Retry-After for a retry-later answer: the upstream's own value (delta
// seconds or an HTTP date) kept within 15-30 s; 30 s for storage pressure.
function retryAfterSeconds(error, status, now = Date.now()) {
  let seconds = parseRetryAfterSeconds(error?.retryAfter, now);
  if (seconds == null) seconds = status === INSUFFICIENT_STORAGE_STATUS ? MAX_RETRY_AFTER_SECONDS : MIN_RETRY_AFTER_SECONDS;
  return Math.min(Math.max(seconds, MIN_RETRY_AFTER_SECONDS), MAX_RETRY_AFTER_SECONDS);
}

// A 429 that will not clear within the 30 s a browser retry waits (issue
// #340): the upstream asked for more than 30 s, or the per-key submission
// quota is used up and no Retry-After says when it frees.
function limitedRateLimit(error, status, now = Date.now()) {
  if (status !== 429) return null;
  const seconds = parseRetryAfterSeconds(error?.retryAfter, now);
  const limited = seconds != null ? seconds > MAX_RETRY_AFTER_SECONDS : isQuotaRateLimit(error);
  if (!limited) return null;
  return { kind: 'limited', upstreamStatus: status, ...(seconds != null ? { retryAfterSeconds: seconds } : {}) };
}

export function isSubmitTimeout(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError' || /aborted due to timeout|timed out/i.test(error?.message || '');
}

export function isRetryLaterStatus(status, retryAfter) {
  return RETRY_LATER_STATUS.has(status) || (status === 503 && Boolean(retryAfter));
}

// Resolves { kind, upstreamStatus?, retryAfterSeconds? } where kind is
//   'rejected'    the file was refused (400, 413, 415, 422)
//   'retry_later' nothing was taken, try again after retryAfterSeconds
//   'limited'     a 429 that will not clear within 30 s (per-key quota used
//                 up, or a longer Retry-After; issue #340); retryAfterSeconds
//                 is the upstream's own value when it sent one
//   'unreachable' the request never reached WinDbg-API: the connection was
//                 never established, or Cloudflare answered 521/523/525/526
//                 (issue #335)
//   'config'      upstream auth/proxy refusal (401, 403, 407)
//   'refused'     any other 4xx
//   'unconfirmed' the upstream may have accepted the upload before failing
//                 (5xx other than the retry-later and origin-not-reached
//                 ones, e.g. 502/504/520/522/524; a 2xx without a job,
//                 a timeout or a connection lost mid-request); retrying it
//                 can queue a second job (issues #140, #328)
//   'local'       a failure on this side, before any upstream request
export function classifyWinDbgSubmitFailure(error) {
  if (error?.code === 'WINDBG_UPSTREAM_INVALID_JSON' || error?.code === 'WINDBG_UPSTREAM_NO_JOB_ID') {
    return { kind: 'unconfirmed' };
  }
  const status = upstreamStatusOf(error);
  if (status == null) {
    const networkCode = error?.cause?.code ?? error?.code;
    if (PRE_SEND_NETWORK_CODES.has(networkCode)) {
      return { kind: 'unreachable', retryAfterSeconds: MIN_RETRY_AFTER_SECONDS };
    }
    if (isSubmitTimeout(error) || isTransportError(error)) return { kind: 'unconfirmed' };
    return { kind: 'local' };
  }
  if (REJECTED_FILE_STATUS.has(status)) return { kind: 'rejected', upstreamStatus: status };
  if (ORIGIN_NOT_REACHED_STATUS.has(status)) {
    return { kind: 'unreachable', upstreamStatus: status, retryAfterSeconds: MIN_RETRY_AFTER_SECONDS };
  }
  const limited = limitedRateLimit(error, status);
  if (limited) return limited;
  if (isRetryLaterStatus(status, error?.retryAfter)) {
    return { kind: 'retry_later', upstreamStatus: status, retryAfterSeconds: retryAfterSeconds(error, status) };
  }
  if (SERVER_CONFIG_STATUS.has(status)) return { kind: 'config', upstreamStatus: status };
  if (status >= 400 && status < 500) return { kind: 'refused', upstreamStatus: status };
  return { kind: 'unconfirmed', upstreamStatus: status };
}

// Socket-level failure codes Node and undici report for a lost or refused
// connection.
const SOCKET_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'UND_ERR_CONNECT_TIMEOUT'
]);

// Node's fetch rejects with TypeError('fetch failed') and the socket-level
// reason in `cause`; once connected, the upload may already be upstream.
// A reset is ambiguous even when it comes early: undici does not report
// whether any request byte reached WinDbg-API, so only the pre-send codes
// (PRE_SEND_NETWORK_CODES) count as nothing sent.
export function isTransportError(error) {
  return (error?.name === 'TypeError' && /fetch failed/i.test(error?.message || ''))
    || typeof error?.cause?.code === 'string'
    || SOCKET_ERROR_CODES.has(error?.code);
}

// True when a failed submit may still have created an upstream job: the
// upload route then holds the dump instead of submitting it again (#328).
export function isUnconfirmedSubmitFailure(error) {
  return classifyWinDbgSubmitFailure(error).kind === 'unconfirmed';
}
