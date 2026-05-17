import { API_LIMITS, MAGIC_SIGNATURES, SECURITY } from '../shared/ingestPolicy.js';

export const SECURITY_CONFIG = {
  file: SECURITY.file,
  zip: SECURITY.zip,
  processing: {
    maxStringLength: 25000,
    maxHexDumpSize: 1024,
    maxConcurrentFiles: 5,
    processingTimeout: 30000
  },
  api: {
    maxRequestSize: API_LIMITS.maxRequestSize,
    rateLimiting: API_LIMITS.rateLimiting,
    maxConcurrentRequests: API_LIMITS.maxConcurrentRequests
  },
  validation: {
    dmpMagicBytes: MAGIC_SIGNATURES.fileValidation.dmpMagic,
    zipMagicBytes: MAGIC_SIGNATURES.fileValidation.zipMagic,
    sevenZipMagicBytes: MAGIC_SIGNATURES.fileValidation.sevenZipMagic,
    rarMagicBytes: MAGIC_SIGNATURES.fileValidation.rarMagic
  }
};

export type SecurityConfig = typeof SECURITY_CONFIG;
