import { API_LIMITS } from './shared/ingestPolicy.js';

export const SECURITY_CONFIG = {
  api: {
    ...API_LIMITS,
    rateLimiting: {
      ...API_LIMITS.rateLimiting,
      maxRequests: 500
    }
  }
};
