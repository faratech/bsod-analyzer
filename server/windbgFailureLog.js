// Log fields for a failed WinDBG upstream call. The message alone is not
// diagnosable: Node's fetch reports every transport failure as the bare
// string "fetch failed" and hides the socket-level reason in `cause`, while
// upstream HTTP failures carry their status in `upstreamStatus`/`code`
// (shared/windbgApiClient.js). Keep those beside a bounded message so
// windbg.upload.fail / windbg.status.fail / windbg.download.fail entries in
// Cloud Logging say *why* the upstream failed, not just that it did.
// Undefined fields are dropped by JSON.stringify at emit time.
export function windbgFailureLogFields(error) {
  const cause = error?.cause;
  const upstreamStatus = Number(error?.upstreamStatus);
  return {
    message: String(error?.message || '').slice(0, 500),
    name: error?.name && error.name !== 'Error' ? String(error.name) : undefined,
    code: error?.code || undefined,
    upstreamStatus: Number.isFinite(upstreamStatus) && error?.upstreamStatus != null
      ? upstreamStatus
      : undefined,
    causeCode: cause?.code || undefined,
    cause: cause ? String(cause.message || cause).slice(0, 200) : undefined
  };
}
