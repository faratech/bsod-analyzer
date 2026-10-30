// The request path middleware sees, and the shape policy for odd paths
// (issue #350).
//
// req.path used to come from new URL(request.url, 'http://localhost'), which
// gives the target WHATWG authority semantics: "//about" became host "about"
// with path "/", backslashes became slashes and dot segments were resolved
// ("/api/analyze/status/..\..\..\health" -> "/health"). Fastify routes on the
// raw target, so middleware (the ingress and maintenance /health exemptions,
// blockedPaths, the catch-all's route selection) and the router disagreed.
// requestTargetPath keeps the raw target; pathShapeVerdict then decides what
// to do with paths no browser sends:
//   - a target that is not origin-form (absolute-form "http://h/p", "*"): 400
//     (issue #358).
//   - duplicate slashes: 301 (308 for other methods, so the body is resent)
//     to the collapsed path, query kept. The collapsed path starts with exactly
//     one "/", so the Location can never be protocol-relative.
//   - backslashes and "."/".." segments: 400. Browsers normalise both before
//     sending, so only crafted requests carry them, and normalising them here
//     would recreate the disagreement with the router.

// Path of a request target, without query or fragment and without any
// normalisation. Only origin-form ("/p?q") is accepted (issue #358):
// find-my-way strips absolute-form with /^https?:\/\/.*?\//, which runs past
// "?" to the first "/", so no authority parsing here could agree with the
// router on every target ("https://x.y?q/health" routed to /health). Any other
// form is returned unparsed (so it never equals a real path such as /health
// or falls under a prefix such as /api/) and pathShapeVerdict rejects it with
// 400. No known
// client sends absolute-form to the origin: Cloudflare, Cloud Run probes and
// h2c (whose :path is origin-form) all send origin-form targets.
export function requestTargetPath(url) {
  let target = String(url || '');
  const end = target.search(/[?#]/);
  if (end >= 0) target = target.slice(0, end);
  return target || '/';
}

function queryOf(url) {
  const raw = String(url || '');
  const hash = raw.indexOf('#');
  const withoutFragment = hash >= 0 ? raw.slice(0, hash) : raw;
  const at = withoutFragment.indexOf('?');
  return at >= 0 ? withoutFragment.slice(at) : '';
}

function hasDotSegment(pathname) {
  return pathname.split('/').some(segment => segment === '.' || segment === '..');
}

// decodedPath: req.path (percent-decoded the way the router decodes it).
// rawUrl: the request target as received (req.originalUrl).
// Returns null, { status: 400 } or { status: 301|308, location }.
export function pathShapeVerdict(decodedPath, rawUrl, method = 'GET') {
  // Absolute-form, asterisk-form ("OPTIONS *") and anything else that is not
  // origin-form (issue #358).
  if (!String(rawUrl || '').startsWith('/')) return { status: 400 };
  const pathname = String(decodedPath || '');
  if (pathname.includes('\\') || hasDotSegment(pathname)) return { status: 400 };
  const rawPath = requestTargetPath(rawUrl);
  if (!/\/\/+/.test(rawPath)) return null;
  const location = rawPath.replace(/\/{2,}/g, '/') + queryOf(rawUrl);
  const status = method === 'GET' || method === 'HEAD' ? 301 : 308;
  return { status, location };
}

export function createPathShapeMiddleware() {
  return function pathShapeGate(req, res, next) {
    const verdict = pathShapeVerdict(req.path, req.originalUrl ?? req.url, req.method);
    if (!verdict) return next();
    if (verdict.status === 400) return res.status(400).send('Bad Request');
    return res.redirect(verdict.status, verdict.location);
  };
}
