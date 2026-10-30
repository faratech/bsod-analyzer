// HTTP answers for WinDbg-API failures behind the browser's WinDBG routes.
import { classifyWinDbgSubmitFailure, INSUFFICIENT_STORAGE_STATUS, isSubmitTimeout, isTransportError } from './windbgSubmitFailure.js';

// Map a WinDBG upstream error on the status poll and download (idempotent
// reads) to an HTTP status: an invalid/garbled or failing upstream response,
// or a connection reset or refused on the way to WinDbg-API (#334), is a
// bad-gateway (502), not an internal error (500), so the browser retries the
// poll instead of treating it as a hard local failure.
export function winDbgUpstreamHttpStatus(error) {
  const code = error?.code;
  if (isSubmitTimeout(error)) {
    return 504;
  }
  if (code === 'WINDBG_UPSTREAM_INVALID_JSON' || code === 'WINDBG_UPSTREAM_ERROR' || isTransportError(error)) {
    return 502;
  }
  return 500;
}

// The `code` sent with winDbgUpstreamHttpStatus's answer, never empty.
export function winDbgUpstreamFailureCode(error) {
  if (isSubmitTimeout(error)) return 'WINDBG_UPSTREAM_TIMEOUT';
  const code = error?.code;
  if (typeof code === 'string' && code.startsWith('WINDBG_UPSTREAM_')) return code;
  if (isTransportError(error)) return 'WINDBG_UPSTREAM_UNREACHABLE';
  return 'INTERNAL_ERROR';
}

const UPLOAD_FAILED_MESSAGE = 'Failed to upload file to the debugging server. Please try again later.';

function failed(status, error, code, retryable, headers) {
  return {
    status,
    ...(headers ? { headers } : {}),
    body: { success: false, error, ...(code ? { code } : {}), ...(retryable === undefined ? {} : { retryable }) }
  };
}

// /api/windbg/upload failure answer (issues #325, #327). The browser retries
// an upload only when the answer says it may help, which is only when nothing
// was created upstream (#328). The failure is classified once
// (server/windbgSubmitFailure.js, shared with /api/analyze): only a refusal of
// the file itself is answered as a rejected dump.
export function windbgUploadFailureResponse(error) {
  const failure = classifyWinDbgSubmitFailure(error);
  switch (failure.kind) {
    case 'rejected':
      return failed(
        422,
        'The debugging server rejected this file. Please ensure it is a supported Windows crash dump (a minidump or a 64-bit kernel dump).',
        'WINDBG_UPLOAD_REJECTED',
        false
      );
    case 'retry_later':
      return failed(
        503,
        failure.upstreamStatus === INSUFFICIENT_STORAGE_STATUS
          ? 'The analysis server is temporarily out of space. Please try again in a few minutes.'
          : 'The debugging server is busy right now. Please try again shortly.',
        'WINDBG_UPLOAD_RETRY_LATER',
        true,
        { 'Retry-After': String(failure.retryAfterSeconds) }
      );
    case 'limited':
      // A per-key quota or a long Retry-After: a re-upload within the
      // browser's 30 s retry window would be refused again (issue #340).
      return failed(
        503,
        'The debugging server has reached its analysis limit for now, so this file is analyzed locally instead. Please try again later for a full WinDBG analysis.',
        'WINDBG_UPLOAD_LIMITED',
        false,
        failure.retryAfterSeconds == null ? undefined : { 'Retry-After': String(failure.retryAfterSeconds) }
      );
    case 'unreachable':
      // Nothing reached WinDbg-API: the connection was never established, or
      // Cloudflare answered 521/523/525/526 (issue #335).
      return failed(502, 'The debugging server could not be reached. Please try again shortly.', 'WINDBG_UPLOAD_UNREACHABLE', true,
        { 'Retry-After': String(failure.retryAfterSeconds) });
    case 'config':
    case 'refused':
      return failed(502, 'The debugging server could not take this upload right now. This is a server-side problem, not a problem with your file. Please try again later.', 'WINDBG_UPLOAD_FAILED', false);
    case 'unconfirmed':
      // WinDbg-API may have queued the job before the failure, and it has no
      // file-hash dedupe: a re-upload would queue a second one (#140, #328).
      // The upload route holds this dump for the ownership window instead.
      return failed(
        isSubmitTimeout(error) ? 504 : 502,
        'The debugging server did not confirm the upload and may still be processing it. Please wait a few minutes before analyzing this file again.',
        'WINDBG_UPLOAD_UNCONFIRMED',
        false
      );
    default:
      // A local failure (500) does not clear up on its own.
      return failed(500, UPLOAD_FAILED_MESSAGE);
  }
}
