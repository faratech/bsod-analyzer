// Quota refund policy (issue #77). Pure functions: classify why an AI provider
// call failed and decide whether that failure class earns a quota refund, plus
// the per-window refund cap. No I/O so tests can exercise it directly
// (tests/quotaPolicy.test.mjs).

// Failure classes:
// - 'timeout':          transport-level stall (AI_TIMEOUT, aborts, "timed out")
// - 'upstream':         the provider answered with an HTTP error / upstream error
// - 'invalid_response': the provider answered but the report failed validation
// - 'config':           server misconfiguration (missing key, unknown model)
// - 'unknown':          anything else (local bugs, unexpected throws)
export const REFUNDABLE_FAILURE_CLASSES = new Set(['timeout', 'upstream', 'invalid_response']);

export function classifyQuotaFailure(error) {
  const code = error?.code;
  const message = String(error?.message || '');

  if (code === 'AI_NOT_CONFIGURED' || code === 'UNSUPPORTED_AI_MODEL') return 'config';
  if (
    code === 'AI_TIMEOUT'
    || error?.name === 'TimeoutError'
    || error?.name === 'AbortError'
    || /timed out|aborted/i.test(message)
  ) {
    return 'timeout';
  }
  if (code === 'INVALID_AI_RESPONSE') return 'invalid_response';
  if (typeof error?.status === 'number' && error.status >= 400) return 'upstream';
  if (code === 'AI_UPSTREAM_ERROR' || code === 'AI_AUTH_FAILED') return 'upstream';
  return 'unknown';
}

export function shouldRefund(error) {
  return REFUNDABLE_FAILURE_CLASSES.has(classifyQuotaFailure(error));
}

// Default cap: half the hourly request allowance, never fewer than 5 refunds.
// QUOTA_REFUND_CAP overrides (e.g. '0' to disable refunds entirely).
export function refundCapFor(requestsLimit, configuredCap = parseEnvCap()) {
  if (Number.isFinite(configuredCap) && configuredCap >= 0) return Math.floor(configuredCap);
  return Math.max(5, Math.floor(requestsLimit / 2));
}

function parseEnvCap() {
  const raw = process.env.QUOTA_REFUND_CAP;
  if (raw === undefined || raw === '') return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
