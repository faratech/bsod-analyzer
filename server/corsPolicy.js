// CORS origin policy for every route (registered once via @fastify/cors with
// `credentials: true`, so an allowed origin can read session-authenticated
// responses).
//
// Only this app's own origin is allowed by default (issue #139). The forum
// hosts must NOT be listed: windowsforum.com and www.windowsforum.com are
// same-site with bsod.windowsforum.com, so their fetches carry the
// SameSite=Lax session cookie, and a credentialed grant would let any script
// on the forum origin (add-ons, third-party tags, an XSS) call every
// session-gated BSOD API as the visitor and read the result. The forum embeds
// the stats widget as a frame (frame-ancestors in securityHeaders.js), which
// needs no CORS. If a forum page ever needs a BSOD API cross-origin, grant
// that route on its own, without credentials.

export const APP_ORIGIN = 'https://bsod.windowsforum.com';

const DEV_ORIGINS = [
  'http://localhost:5173', // Vite dev server
  'http://localhost:8080', // Local server
  'http://localhost:3000'  // Common React dev port
];

export function allowedCorsOrigins(env = process.env) {
  const origins = [];
  if (env.NODE_ENV !== 'production') origins.push(...DEV_ORIGINS);
  // Production origins from environment
  if (env.PRODUCTION_URL) origins.push(env.PRODUCTION_URL);
  if (env.ALLOWED_ORIGINS) {
    // Support comma-separated list
    origins.push(...env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean));
  }
  origins.push(APP_ORIGIN);
  return origins;
}

// @fastify/cors `origin` callback. The environment is read per request, as
// before, so ALLOWED_ORIGINS changes need no code change.
export function createCorsOriginCheck({ env = process.env, warn = console.warn } = {}) {
  return function corsOrigin(origin, callback) {
    // Allow requests with no origin (same-origin, server-side, curl, etc.).
    // This is safe and necessary for Cloud Run.
    if (!origin) {
      return callback(null, true);
    }

    // Allow file:// only during local development.
    if (env.NODE_ENV !== 'production' && origin.startsWith('file://')) {
      return callback(null, true);
    }

    if (allowedCorsOrigins(env).includes(origin)) {
      return callback(null, true);
    }

    // Deny by omitting CORS headers instead of throwing: an error here used
    // to surface as 500 INTERNAL_ERROR, polluting error alerting for what is
    // a routine cross-origin denial. Browsers still block the read.
    warn(`CORS blocked origin: ${origin}`);
    return callback(null, false);
  };
}
