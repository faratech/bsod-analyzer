// The analyzer page's data-use checkbox state (components/DataUseAgreement.tsx).
// Requests that submit dump data attach the accepted terms version; the server
// rejects them without it (server/dataUseTerms.js).
import { DATA_USE_TERMS_HEADER, DATA_USE_TERMS_VERSION } from '../shared/dataUseTerms.js';

export const DATA_USE_STORAGE_KEY = 'bsod.dataUse.declined';
// The terms version this browser last agreed to: written when the visitor
// checks the box or submits dump data with it checked. A different stored
// version means the terms changed since, and the analyzer asks again, as
// /privacy promises (issue #144). A browser with nothing stored gets the
// default-checked box, as before.
export const DATA_USE_ACCEPTED_VERSION_KEY = 'bsod.dataUse.acceptedVersion';

let accepted = true;

export function setDataUseAccepted(value: boolean): void {
  accepted = value;
}

export function isDataUseAccepted(): boolean {
  return accepted;
}

export function rememberDataUseAcceptance(): void {
  try {
    window.localStorage.setItem(DATA_USE_ACCEPTED_VERSION_KEY, DATA_USE_TERMS_VERSION);
  } catch { /* storage unavailable: nothing to compare against later */ }
}

// True when this browser agreed to an earlier version of the terms.
export function dataUseTermsChangedSinceAcceptance(): boolean {
  try {
    const stored = window.localStorage.getItem(DATA_USE_ACCEPTED_VERSION_KEY);
    return stored !== null && stored !== DATA_USE_TERMS_VERSION;
  } catch {
    return false;
  }
}

export function dataUseHeaders(): Record<string, string> {
  if (!accepted) return {};
  // Sending the header is the acceptance: record which version it was.
  rememberDataUseAcceptance();
  return { [DATA_USE_TERMS_HEADER]: DATA_USE_TERMS_VERSION };
}
