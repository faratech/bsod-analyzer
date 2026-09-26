// Data-use terms for dump analysis (see /privacy). The analyzer page asks the
// visitor to accept them (checked by default) and every request that submits
// dump data carries the accepted version in DATA_USE_TERMS_HEADER; the server
// rejects requests without the current version. Bump the version when the
// terms change so earlier acceptances no longer count.
export const DATA_USE_TERMS_VERSION = '2026-09';
export const DATA_USE_TERMS_HEADER = 'X-Data-Use-Terms';

export function acceptsCurrentDataUseTerms(value) {
  return String(value ?? '').trim() === DATA_USE_TERMS_VERSION;
}
