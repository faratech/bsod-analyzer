// Security-header construction + global middleware, extracted from server.js.
// Two CSP variants exist: the default strict one, and an embeddable variant
// for widget routes (e.g. /stats/embed) that may be iframed from
// windowsforum.com forum threads. Embeddable paths drop X-Frame-Options
// entirely (it cannot be relaxed, only omitted) and widen frame-ancestors;
// every other header stays identical so non-embed responses are unchanged.
//
// script-src policy (issue #74): 'unsafe-inline' nullifies XSS protection.
// The inline scripts are hashed instead — but the hashes MUST match the exact
// bytes served, and server.js rewrites flag literals inside those scripts at
// startup (injectSsoFlags), so the authoritative hash set is computed from the
// served HTML at boot (see updateInlineScriptHashes) rather than at build time.
// Until hashes are provided (or in CSP_MODE=report-only), the enforcing header
// keeps the legacy 'unsafe-inline' policy so nothing regresses.

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

// 'wasm-unsafe-eval' is required: the client bundle hashes uploads with
// xxhash-wasm and cannot run without WebAssembly.
const WASM_SOURCE = 'wasm-unsafe-eval';

function scriptSources({ inlineScriptSources }) {
  // `inlineScriptSources` is either "'unsafe-inline'" or a list of
  // 'sha256-…' hashes covering every inline script actually served.
  return `'self' ${inlineScriptSources} ${WASM_SOURCE} ${AD_SCRIPT_SOURCES}`;
}

function cspDirectives(frameAncestors, inlineScriptSources) {
  return [
    "default-src 'self'",
    // *.doubleclick.net + www.googleadservices.com cover Google Ads conversion
    // tracking scripts (gtag loads viewthroughconversion/conversion_async from these).
    `script-src ${scriptSources({ inlineScriptSources })}`,
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

const LEGACY_INLINE_SOURCES = "'unsafe-inline'";
export const CSP_HEADER = cspDirectives(DEFAULT_FRAME_ANCESTORS, LEGACY_INLINE_SOURCES);
export const CSP_EMBED_HEADER = cspDirectives(EMBED_FRAME_ANCESTORS, LEGACY_INLINE_SOURCES);

export const EMBEDDABLE_PATHS = ['/stats/embed'];

// Rollout switch (issue #74):
// - 'report-only' (default): the enforcing header keeps the legacy policy and
//   the hash-based policy ships as Content-Security-Policy-Report-Only, so any
//   script the hashes miss surfaces in logs without breaking the site.
// - 'enforce': the hash-based policy becomes the enforcing header.
export const CSP_MODE = ['report-only', 'enforce'].includes(process.env.CSP_MODE)
  ? process.env.CSP_MODE
  : 'report-only';

// Extract inline <script> contents and return their CSP source expressions.
// Exported so server.js and tests share one implementation. `sha256` must be a
// base64-digesting hash function — supplied by the caller, not defaulted.
export function computeInlineScriptSources(html, { sha256 }) {
  if (typeof sha256 !== 'function') {
    throw new TypeError('computeInlineScriptSources requires a sha256(content) function');
  }
  const hashes = new Set();
  const scripts = String(html || '').matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, content] of scripts) {
    if (!content || !content.trim()) continue;
    hashes.add(`'sha256-${sha256(content)}'`);
  }
  return [...hashes];
}

export function createSecurityHeadersMiddleware({
  cspHeader = CSP_HEADER,
  cspEmbedHeader = CSP_EMBED_HEADER,
  embeddablePaths = EMBEDDABLE_PATHS,
  cspMode = CSP_MODE
} = {}) {
  const embedPrefixes = embeddablePaths.map(p => `${p}/`);
  const isEmbeddable = (path) => {
    if (!path) return false;
    const clean = path.split('?')[0];
    return embeddablePaths.includes(clean) || embedPrefixes.some(prefix => clean.startsWith(prefix));
  };

  // Null until server.js hands over the hashes computed from the served HTML;
  // headers derived from them are cached and invalidated on update.
  let inlineScriptSources = null;
  let strictHeaders = null;
  let strictEmbedHeaders = null;

  function strictPolicyFor(variant) {
    const inline = inlineScriptSources ? inlineScriptSources.join(' ') : LEGACY_INLINE_SOURCES;
    return variant === 'embed'
      ? cspDirectives(EMBED_FRAME_ANCESTORS, inline)
      : cspDirectives(DEFAULT_FRAME_ANCESTORS, inline);
  }

  function recompute() {
    strictHeaders = strictPolicyFor('default');
    strictEmbedHeaders = strictPolicyFor('embed');
  }

  function headersFor(variant) {
    const legacy = variant === 'embed' ? cspEmbedHeader : cspHeader;
    const result = {};
    if (cspMode === 'enforce' && inlineScriptSources) {
      // Hash-based policy takes over enforcement entirely.
      result.csp = variant === 'embed' ? strictEmbedHeaders : strictHeaders;
    } else {
      // Legacy policy keeps enforcing while the strict policy is staged.
      result.csp = legacy;
      if (inlineScriptSources) {
        result.cspReportOnly = variant === 'embed' ? strictEmbedHeaders : strictHeaders;
      }
    }
    return result;
  }

  recompute();

  const middleware = function securityHeaders(req, res, next) {
    const embeddable = isEmbeddable(req.path || req.url);
    const variant = embeddable ? 'embed' : 'default';
    const policy = headersFor(variant);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!embeddable) {
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    }
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('Content-Security-Policy', policy.csp);
    if (policy.cspReportOnly) {
      res.setHeader('Content-Security-Policy-Report-Only', policy.cspReportOnly);
    }
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    next();
  };

  // server.js calls this once the served HTML variants are cached at startup.
  middleware.updateInlineScriptHashes = (hashes) => {
    const next = (Array.isArray(hashes) ? hashes : []).filter(h => /^'sha256-[A-Za-z0-9+/=]+'$/.test(h)).sort();
    const changed = JSON.stringify(next) !== JSON.stringify(inlineScriptSources || []);
    inlineScriptSources = next.length > 0 ? next : null;
    recompute();
    return changed;
  };

  middleware.hasInlineScriptHashes = () => Boolean(inlineScriptSources);

  return middleware;
}
