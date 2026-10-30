// The production catch-all's HTML documents (issue #264): which prerendered
// markup each route gets, and the strong ETag / If-None-Match handling.
//
// Each route must get its OWN prerendered markup, or the client-rendered shell
// for routes that were not prerendered — never another route's, or hydration
// mismatches. ETags are computed from the exact bytes served (after
// injectSsoFlags), so a 304 is only ever sent for the document that would
// otherwise be delivered. Extracted from server.js so it is unit-testable
// (tests/htmlDocuments.test.mjs); server.js keeps the file reads and `res`.
import crypto from 'crypto';

// "/about/" -> "/about", "" or "///" -> "/".
export function normalizeRoutePath(pathname) {
  return String(pathname || '').replace(/\/+$/, '') || '/';
}

// dist/prerendered/<name>.html is served for the route "/<name>".
export function prerenderedRouteKey(fileName) {
  if (typeof fileName !== 'string' || !fileName.endsWith('.html')) return null;
  return '/' + fileName.slice(0, -5);
}

// The raw build documents are never served as files (issue #349): they would
// skip injectSsoFlags, the strong ETag policy and the per-route rule. Their
// URLs redirect to the route that serves the same markup; returns that route,
// or null for any other path.
const PRERENDERED_FILE_RE = /^\/prerendered\/([a-z0-9_-]+)\.html$/i;
export function buildHtmlRedirect(pathname) {
  const p = String(pathname || '');
  if (p === '/index.html' || p === '/index.prerendered.html') return '/';
  const match = p.match(PRERENDERED_FILE_RE);
  return match ? '/' + match[1] : null;
}

export function htmlEtag(html) {
  return '"' + crypto.createHash('sha256').update(html).digest('base64url').slice(0, 27) + '"';
}

// Exact (strong) comparison against a comma-separated If-None-Match list.
export function ifNoneMatchHits(ifNoneMatch, etag) {
  if (!ifNoneMatch || !etag) return false;
  return String(ifNoneMatch).split(',').map(s => s.trim()).includes(etag);
}

// indexHtml: the client-rendered shell (dist/index.html).
// homeHtml: the prerendered homepage, served for "/" (defaults to the shell).
// routeHtml: { "/about": markup, ... } from dist/prerendered.
// transform: applied to every document before its ETag is computed
// (server.js passes injectSsoFlags).
// withEtags: false for the "Build not found" placeholder (no validators).
export function createHtmlDocuments({
  indexHtml,
  homeHtml,
  routeHtml = {},
  transform = html => html,
  withEtags = true
} = {}) {
  const shell = indexHtml === undefined ? undefined : transform(indexHtml);
  const home = homeHtml === undefined ? shell : transform(homeHtml);
  const routes = new Map();
  for (const [route, html] of Object.entries(routeHtml)) {
    // An empty prerender is treated as absent: the route gets the shell.
    if (typeof html === 'string' && html.length > 0) routes.set(route, transform(html));
  }

  const etags = new Map();
  if (withEtags && shell !== undefined) {
    etags.set('/', htmlEtag(home));
    for (const [route, html] of routes) etags.set(route, htmlEtag(html));
  }
  const shellEtag = withEtags && shell !== undefined ? htmlEtag(shell) : undefined;

  // The document and its ETag come from the same lookup, so they cannot
  // drift apart.
  function select(pathname) {
    const route = normalizeRoutePath(pathname);
    if (route === '/') return { html: home, etag: etags.get('/') };
    if (routes.has(route)) return { html: routes.get(route), etag: etags.get(route) };
    return { html: shell, etag: shellEtag };
  }

  // { status: 200, html, etag } or { status: 304, etag } on a revalidation hit.
  // etag is undefined only without a build; the caller must not set the header.
  function resolve(pathname, ifNoneMatch) {
    const { html, etag } = select(pathname);
    if (ifNoneMatchHits(ifNoneMatch, etag)) return { status: 304, etag };
    return { status: 200, html, etag };
  }

  return {
    indexHtml: shell,
    homeHtml: home,
    routeHtml: Object.fromEntries(routes),
    // Every HTML variant the server can serve (CSP inline-script hashes).
    variants: () => [shell, home, ...routes.values()].filter(html => html !== undefined),
    select,
    resolve
  };
}
