// The analyzer page's data-use checkbox state (components/DataUseAgreement.tsx).
// Requests that submit dump data attach the accepted terms version; the server
// rejects them without it (server/dataUseTerms.js).
import { DATA_USE_TERMS_HEADER, DATA_USE_TERMS_VERSION } from '../shared/dataUseTerms.js';

export const DATA_USE_STORAGE_KEY = 'bsod.dataUse.declined';

let accepted = true;

export function setDataUseAccepted(value: boolean): void {
  accepted = value;
}

export function isDataUseAccepted(): boolean {
  return accepted;
}

export function dataUseHeaders(): Record<string, string> {
  return accepted ? { [DATA_USE_TERMS_HEADER]: DATA_USE_TERMS_VERSION } : {};
}
