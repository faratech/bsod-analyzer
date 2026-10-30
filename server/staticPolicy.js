// Content-Type and cache policy for files the static middleware serves from
// dist (issue #348). Extracted from server.js so it is unit-testable
// (tests/staticPolicy.test.mjs).
//
// Every file gets an explicit Content-Type and Cache-Control: the site sends
// `X-Content-Type-Options: nosniff` globally, so a missing type is never
// sniffed (ads.txt must be text/plain per the IAB spec), and a missing
// Cache-Control would fall back to staticMiddleware's one-year default.
// Only /assets/ holds content-hashed build output, so only it is immutable;
// unhashed root files (ads.txt, robots.txt, favicons, OG image, manifest...)
// must reach returning browsers within a day of being replaced.
import path from 'path';
import { buildHtmlRedirect } from './htmlDocuments.js';

export const MIME_TYPES = {
  '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.html': 'text/html', '.json': 'application/json',
  '.txt': 'text/plain', '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const TEXT_EXTS = new Set(['.js', '.mjs', '.css', '.html', '.json', '.txt', '.xml', '.webmanifest']);
const FONT_EXTS = new Set(['.woff2', '.woff', '.ttf', '.otf', '.eot']);

export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
export const UNHASHED_CACHE = 'public, max-age=86400';
export const NO_CACHE = 'public, max-age=0, s-maxage=0';

// Content-Type header value for an extension (charset for text types), or
// application/octet-stream for anything unknown.
export function staticContentType(ext) {
  const key = String(ext || '').toLowerCase();
  const mime = MIME_TYPES[key];
  if (!mime) return 'application/octet-stream';
  return TEXT_EXTS.has(key) ? `${mime}; charset=utf-8` : mime;
}

// relPath: the file's path relative to the static root, '/'-separated
// (e.g. "assets/index-abc.js", "ads.txt", "symbols/ntoskrnl.json").
export function staticCacheControl(relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (rel === 'sw.js') return NO_CACHE;
  if (rel.startsWith('assets/')) return IMMUTABLE_CACHE;
  return UNHASHED_CACHE;
}

// All response headers for one static file.
export function staticHeadersFor(relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const ext = path.posix.extname(rel).toLowerCase();
  const headers = {
    'Content-Type': staticContentType(ext),
    'Cache-Control': staticCacheControl(rel),
    'X-Content-Type-Options': 'nosniff'
  };
  if (FONT_EXTS.has(ext) || (ext === '.json' && rel.startsWith('symbols/'))) {
    headers['Access-Control-Allow-Origin'] = '*';
  }
  return headers;
}

// Legacy locations answered with a permanent redirect to the canonical file.
// RFC 9116 places security.txt under /.well-known/.
export const STATIC_REDIRECTS = Object.freeze({
  '/security.txt': '/.well-known/security.txt'
});

// GET/HEAD redirects that run before static serving (issue #357; mounted by
// server.js right after the blocked-path gate):
//   - STATIC_REDIRECTS legacy locations (/security.txt), query dropped;
//   - raw build documents (issue #349): /index.html, /index.prerendered.html
//     and /prerendered/<route>.html go to their route with the query kept, so
//     every document is served by the catch-all (SSO flags, strong ETag, each
//     route its own prerendered markup).
export function createStaticRedirectMiddleware() {
  return function staticRedirects(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const legacy = Object.hasOwn(STATIC_REDIRECTS, req.path) ? STATIC_REDIRECTS[req.path] : null;
    if (legacy) return res.redirect(301, legacy);
    const route = buildHtmlRedirect(req.path);
    if (!route) return next();
    const url = String(req.originalUrl || '');
    const queryAt = url.indexOf('?');
    return res.redirect(301, queryAt >= 0 ? route + url.slice(queryAt) : route);
  };
}
