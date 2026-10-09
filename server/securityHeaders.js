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
//
// Issue #154: the hash-based ("strict") policy also narrows the wildcard script
// hosts to the hosts the site's third parties load from, and reports every
// violation to CSP_REPORT_PATH, so Report-Only mode yields the data needed to
// flip CSP_MODE to 'enforce'. The legacy policy keeps its original host list:
// it is what enforces today, and its 'unsafe-inline' makes host gadgets moot.

// Legacy enforcing policy only (unchanged).
const AD_SCRIPT_SOURCES =
  'https://*.cloudflare.com https://static.cloudflareinsights.com https://*.google ' +
  'https://*.google.com https://*.googletagmanager.com https://*.googlesyndication.com ' +
  'https://*.doubleclick.net https://www.googleadservices.com https://adnxs.com ' +
  'https://www.paypalobjects.com';

// Strict policy: exact hosts instead of https://*.cloudflare.com (which covers
// cdnjs.cloudflare.com and every historic library version on it, a classic
// script-gadget source), https://*.google(.com), *.googletagmanager.com,
// *.googlesyndication.com and *.doubleclick.net.
export const STRICT_SCRIPT_HOSTS = [
  // Turnstile (components/CloudflareTurnstile.tsx) and Cloudflare Web Analytics.
  'https://challenges.cloudflare.com',
  'https://static.cloudflareinsights.com',
  // gtag.js (index.html) and the Google Ads conversion scripts it pulls in.
  'https://www.googletagmanager.com',
  'https://www.google.com',
  'https://www.googleadservices.com',
  'https://googleads.g.doubleclick.net',
  // AdSense (adsbygoogle.js) and what it loads: ad runtime, safeframe/sodar,
  // ad-traffic-quality, the integrator and the FundingChoices consent CMP.
  'https://pagead2.googlesyndication.com',
  'https://tpc.googlesyndication.com',
  'https://*.adtrafficquality.google',
  'https://adservice.google.com',
  'https://fundingchoicesmessages.google.com',
  'https://adnxs.com',
  // PayPal donate SDK (components/PayPalDonateButton.tsx).
  'https://www.paypalobjects.com',
].join(' ');

// Where browsers send violation reports for the strict policy, served by
// server/cspReport.js. Only report-uri is used: a policy that also names a
// report-to group makes Chrome skip report-uri and depend on Reporting API
// delivery alone, which could not be verified end to end here (headless Chrome
// delivered report-uri reports at once and Reporting API reports not at all).
// report-uri is still honoured by Chrome, Firefox and Safari.
export const CSP_REPORT_PATH = '/api/csp-report';

const CONNECT_SOURCES =
  "'self' https://windowsforum.com https://challenges.cloudflare.com https://*.google " +
  'https://*.google.com https://*.gstatic.com https://*.googletagmanager.com ' +
  'https://*.googlesyndication.com https://*.doubleclick.net ' +
  'https://www.googleadservices.com ' +
  'https://www.paypal.com';

// 'wasm-unsafe-eval' is required: the client bundle hashes uploads with
// xxhash-wasm and cannot run without WebAssembly.
// The single quotes are part of the CSP token, not JS string syntax. Without them
// the browser parses `wasm-unsafe-eval` as a *host* source expression (a hostname),
// silently grants nothing, and every WebAssembly.instantiate() throws a CompileError
// — which took out the WinDBG upload path, since the client hashes the dump with
// xxhash-wasm before uploading it.
const WASM_SOURCE = "'wasm-unsafe-eval'";

function scriptSources({ inlineScriptSources, strict }) {
  // `inlineScriptSources` is either "'unsafe-inline'" or a list of
  // 'sha256-…' hashes covering every inline script actually served.
  // 'report-sample' puts the first 40 characters of a blocked inline script in
  // the report, which is how an unhashed one (e.g. a CDN-injected snippet) is
  // identified.
  return strict
    ? `'self' ${inlineScriptSources} 'report-sample' ${WASM_SOURCE} ${STRICT_SCRIPT_HOSTS}`
    : `'self' ${inlineScriptSources} ${WASM_SOURCE} ${AD_SCRIPT_SOURCES}`;
}

// `reportOnly` drops directives that browsers refuse to honour in a
// Content-Security-Policy-Report-Only header. Keeping them there is not merely
// inert: Chrome logs an "is ignored when delivered in a report-only policy"
// warning for each one, on every page load, which buries the actual violation
// reports this staged rollout exists to collect.
function cspDirectives(frameAncestors, inlineScriptSources, { reportOnly = false, strict = false } = {}) {
  return [
    "default-src 'self'",
    // *.doubleclick.net + www.googleadservices.com cover Google Ads conversion
    // tracking scripts (gtag loads viewthroughconversion/conversion_async from these).
    `script-src ${scriptSources({ inlineScriptSources, strict })}`,
    // AdSense's adsbygoogle.js runtime injects a small container-sizing stylesheet
    // as a data:text/css URL, so 'data:' is required here for ad slots to render.
    "style-src 'self' 'unsafe-inline' data: https://fonts.googleapis.com https://*.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: https: blob:",
    `connect-src ${CONNECT_SOURCES}`,
    "frame-src 'self' https://challenges.cloudflare.com https://*.google https://*.google.com https://*.googletagmanager.com https://*.googlesyndication.com https://*.doubleclick.net https://www.paypal.com",
    // The app registers /sw.js. Without an explicit worker-src this falls back to
    // script-src, where the hash-based policy has no source that matches a
    // same-origin worker script and the registration is reported as a violation.
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://www.paypal.com",
    `frame-ancestors ${frameAncestors}`,
    ...(reportOnly ? [] : ['upgrade-insecure-requests']),
    ...(strict ? [`report-uri ${CSP_REPORT_PATH}`] : [])
  ].join('; ');
}

const DEFAULT_FRAME_ANCESTORS = "'self'";
const EMBED_FRAME_ANCESTORS = "'self' https://windowsforum.com https://*.windowsforum.com";

const LEGACY_INLINE_SOURCES = "'unsafe-inline'";
export const CSP_HEADER = cspDirectives(DEFAULT_FRAME_ANCESTORS, LEGACY_INLINE_SOURCES);
export const CSP_EMBED_HEADER = cspDirectives(EMBED_FRAME_ANCESTORS, LEGACY_INLINE_SOURCES);

export const EMBEDDABLE_PATHS = ['/stats/embed'];

// Rollout switch (issues #74, #154), set explicitly on every deploy by
// cloudbuild.yaml (_CSP_MODE) and deploy-with-secret.sh:
// - 'report-only' (default): the enforcing header keeps the legacy policy and
//   the hash-based policy ships as Content-Security-Policy-Report-Only; its
//   violations are logged as `csp.violation` events (server/cspReport.js)
//   without breaking the site.
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
  // HTML comments are matched (and skipped) in the same pass, so a comment that
  // mentions a script tag can't start a bogus match that swallows the real
  // script's bytes and leaves it unhashed.
  const scripts = String(html || '').matchAll(/<!--[\s\S]*?-->|<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi);
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
  // Same policy as strictHeaders/strictEmbedHeaders minus the directives that are
  // ignored in a report-only header, so staging the rollout stays quiet in the console.
  let strictReportOnlyHeaders = null;
  let strictEmbedReportOnlyHeaders = null;

  function strictPolicyFor(variant, options = {}) {
    const inline = inlineScriptSources ? inlineScriptSources.join(' ') : LEGACY_INLINE_SOURCES;
    const strictOptions = { ...options, strict: true };
    return variant === 'embed'
      ? cspDirectives(EMBED_FRAME_ANCESTORS, inline, strictOptions)
      : cspDirectives(DEFAULT_FRAME_ANCESTORS, inline, strictOptions);
  }

  function recompute() {
    strictHeaders = strictPolicyFor('default');
    strictEmbedHeaders = strictPolicyFor('embed');
    strictReportOnlyHeaders = strictPolicyFor('default', { reportOnly: true });
    strictEmbedReportOnlyHeaders = strictPolicyFor('embed', { reportOnly: true });
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
        result.cspReportOnly = variant === 'embed' ? strictEmbedReportOnlyHeaders : strictReportOnlyHeaders;
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
