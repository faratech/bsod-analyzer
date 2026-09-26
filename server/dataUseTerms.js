// Express-style middleware: requests that submit dump data from the browser must
// carry the current data-use terms version (shared/dataUseTerms.js).
import { DATA_USE_TERMS_HEADER, acceptsCurrentDataUseTerms } from '../shared/dataUseTerms.js';

export const DATA_USE_TERMS_REQUIRED = 'DATA_USE_TERMS_REQUIRED';

export function requireDataUseTerms(req, res, next) {
  if (acceptsCurrentDataUseTerms(req.headers?.[DATA_USE_TERMS_HEADER.toLowerCase()])) return next();
  return res.status(428).json({
    success: false,
    code: DATA_USE_TERMS_REQUIRED,
    error: 'To analyze dumps, keep "Use my crash analysis to improve BSOD AI" checked on the analyzer page (reload the page if you already have).'
  });
}
