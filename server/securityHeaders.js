// Security-header construction + global middleware, extracted from server.js.
// Two CSP variants exist: the default strict one, and an embeddable variant
// for widget routes (e.g. /stats/embed) that may be iframed from
// windowsforum.com forum threads. Embeddable paths drop X-Frame-Options
// entirely (it cannot be relaxed, only omitted) and widen frame-ancestors;
// every other header stays identical so non-embed responses are unchanged.

const AD_SCRIPT_SOURCES =
  'https://*.cloudflare.com https://static.cloudflareinsights.com https://*.google ' +
  'https://*.google.com https://*.googletagmanager.com https://*.googlesyndication.com ' +
  'https://*.doubleclick.net https://www.googleadservices.com https://adnxs.com ' +
  'https://www.paypalobjects.com';

const CONNECT_SOURCES =
  "'self' https://windowsforum.com https://challenges.cloudflare.com https://*.google " +
  'https://*.google.com https://*.gstatic.com https://*.googletagmanager.com ' +
  'https://*.googlesyndication.com https://*.doubleclick.net ' +
  'https://www.googleadservices.com https://generativelanguage.googleapis.com ' +
  'https://www.paypal.com';

function cspDirectives(frameAncestors) {
  return [
    "default-src 'self'",
    // *.doubleclick.net + www.googleadservices.com cover Google Ads conversion
    // tracking scripts (gtag loads viewthroughconversion/conversion_async from these).
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' ${AD_SCRIPT_SOURCES}`,
    // AdSense's adsbygoogle.js runtime injects a small container-sizing stylesheet
    // as a data:text/css URL, so 'data:' is required here for ad slots to render.
    "style-src 'self' 'unsafe-inline' data: https://fonts.googleapis.com https://*.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: https: blob:",
    `connect-src ${CONNECT_SOURCES}`,
    "frame-src 'self' https://challenges.cloudflare.com https://*.google https://*.google.com https://*.googletagmanager.com https://*.googlesyndication.com https://*.doubleclick.net https://www.paypal.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://www.paypal.com",
    `frame-ancestors ${frameAncestors}`,
    'upgrade-insecure-requests'
  ].join('; ');
}

const DEFAULT_FRAME_ANCESTORS = "'self'";
const EMBED_FRAME_ANCESTORS = "'self' https://windowsforum.com https://*.windowsforum.com";

export const CSP_HEADER = cspDirectives(DEFAULT_FRAME_ANCESTORS);
export const CSP_EMBED_HEADER = cspDirectives(EMBED_FRAME_ANCESTORS);

export const EMBEDDABLE_PATHS = ['/stats/embed'];

export function createSecurityHeadersMiddleware({
  cspHeader = CSP_HEADER,
  cspEmbedHeader = CSP_EMBED_HEADER,
  embeddablePaths = EMBEDDABLE_PATHS
} = {}) {
  const embedPrefixes = embeddablePaths.map(p => `${p}/`);
  const isEmbeddable = (path) => {
    if (!path) return false;
    const clean = path.split('?')[0];
    return embeddablePaths.includes(clean) || embedPrefixes.some(prefix => clean.startsWith(prefix));
  };

  // Precompute per-request branch constants once.
  return function securityHeaders(req, res, next) {
    const embeddable = isEmbeddable(req.path || req.url);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!embeddable) {
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    }
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('Content-Security-Policy', embeddable ? cspEmbedHeader : cspHeader);
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    next();
  };
}
