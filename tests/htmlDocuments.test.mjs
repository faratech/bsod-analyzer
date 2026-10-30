import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createHtmlDocuments,
  htmlEtag,
  ifNoneMatchHits,
  normalizeRoutePath,
  prerenderedRouteKey,
  buildHtmlRedirect
} from '../server/htmlDocuments.js';
import { find, serverAst, text } from './helpers/serverAst.mjs';

// Issue #264: each route gets its own prerendered markup (or the shell), never
// another route's, with an ETag of exactly the bytes served.
const INDEX = '<html><div id="root"></div><script>window.__WF_SSO_ENABLED__=false</script></html>';
const HOME = '<html><div id="root">home</div><script>window.__WF_SSO_ENABLED__=false</script></html>';
const ROUTES = {
  '/about': '<html><div id="root">about</div></html>',
  '/stats': '<html><div id="root">stats</div></html>',
  '/documentation': '<html><div id="root">docs</div></html>'
};
const inject = html => html.replace('__WF_SSO_ENABLED__=false', '__WF_SSO_ENABLED__=true') + '<!--sso-->';

function documents(overrides = {}) {
  return createHtmlDocuments({ indexHtml: INDEX, homeHtml: HOME, routeHtml: ROUTES, transform: inject, ...overrides });
}

test('normalizeRoutePath strips trailing slashes and maps empty to "/"', () => {
  assert.equal(normalizeRoutePath('/'), '/');
  assert.equal(normalizeRoutePath(''), '/');
  assert.equal(normalizeRoutePath('///'), '/');
  assert.equal(normalizeRoutePath('/about'), '/about');
  assert.equal(normalizeRoutePath('/about/'), '/about');
  assert.equal(normalizeRoutePath('/about//'), '/about');
  assert.equal(normalizeRoutePath('/stats/embed/'), '/stats/embed');
});

test('dist/prerendered/<name>.html is keyed as "/<name>"', () => {
  assert.equal(prerenderedRouteKey('about.html'), '/about');
  assert.equal(prerenderedRouteKey('stats.html'), '/stats');
  assert.equal(prerenderedRouteKey('about.htm'), null);
  assert.equal(prerenderedRouteKey('about.html.map'), null);
  assert.equal(prerenderedRouteKey('notes.txt'), null);
});

test('every prerendered route is served its own markup, never another route\'s', () => {
  const docs = documents();
  for (const [route, raw] of Object.entries(ROUTES)) {
    for (const pathname of [route, route + '/', route + '//']) {
      const { status, html } = docs.resolve(pathname);
      assert.equal(status, 200);
      assert.equal(html, inject(raw), `${pathname} must serve ${route}'s markup`);
    }
  }
  assert.equal(docs.resolve('/').html, inject(HOME));
});

test('unknown and dynamic routes get the client-rendered shell', () => {
  const docs = documents();
  for (const pathname of ['/analyzer', '/nope', '/about/team', '/stat', '/aboutx', '/constructor', '/__proto__', '/__fallback']) {
    assert.equal(docs.resolve(pathname).html, inject(INDEX), pathname);
  }
});

test('"/" falls back to the shell when the homepage was not prerendered', () => {
  const docs = documents({ homeHtml: undefined });
  assert.equal(docs.resolve('/').html, inject(INDEX));
  assert.equal(docs.resolve('/').etag, htmlEtag(inject(INDEX)));
  assert.equal(docs.resolve('/about').html, inject(ROUTES['/about']));
});

test('an empty prerendered file is treated as absent (shell and shell ETag together)', () => {
  const docs = documents({ routeHtml: { ...ROUTES, '/donate': '' } });
  const donate = docs.resolve('/donate');
  assert.equal(donate.html, inject(INDEX));
  assert.equal(donate.etag, htmlEtag(inject(INDEX)));
});

test('documents are transformed (SSO flags) before serving and before their ETag', () => {
  const docs = documents();
  for (const pathname of ['/', '/about', '/nope']) {
    const { html, etag } = docs.resolve(pathname);
    assert.ok(html.endsWith('<!--sso-->'), `${pathname} must be served after injectSsoFlags`);
    assert.equal(etag, htmlEtag(html), `${pathname}: the ETag must cover the served bytes`);
  }
  assert.deepEqual(docs.variants().sort(), [inject(INDEX), inject(HOME), ...Object.values(ROUTES).map(inject)].sort());
});

test('ETags are strong, per document, and change when the bytes change', () => {
  const docs = documents();
  const tags = ['/', '/about', '/stats', '/documentation', '/nope'].map(p => docs.resolve(p).etag);
  for (const tag of tags) assert.match(tag, /^"[A-Za-z0-9_-]{27}"$/, 'strong, quoted, no W/ prefix');
  assert.equal(new Set(tags).size, tags.length, 'each document has its own ETag');
  assert.equal(docs.resolve('/about/').etag, docs.resolve('/about').etag);
  assert.equal(docs.resolve('/nope').etag, docs.resolve('/other').etag, 'all shell routes share the shell tag');

  const redeployed = documents({ routeHtml: { ...ROUTES, '/about': ROUTES['/about'] + ' ' } });
  assert.notEqual(redeployed.resolve('/about').etag, docs.resolve('/about').etag);
  assert.equal(redeployed.resolve('/stats').etag, docs.resolve('/stats').etag);
});

test('If-None-Match: exact strong match in a comma-separated list answers 304', () => {
  const docs = documents();
  const etag = docs.resolve('/about').etag;
  assert.deepEqual(docs.resolve('/about', etag), { status: 304, etag });
  assert.equal(docs.resolve('/about', `"stale", ${etag}`).status, 304);
  assert.equal(docs.resolve('/about', `${etag},"other"`).status, 304);
  assert.equal(docs.resolve('/about', `  ${etag}  `).status, 304);

  for (const header of [undefined, '', '"stale"', `W/${etag}`, etag.slice(0, -2) + '"', `"x"${etag}`, '*']) {
    const result = docs.resolve('/about', header);
    assert.equal(result.status, 200, `If-None-Match ${header} must not match`);
    assert.equal(result.html, inject(ROUTES['/about']));
    assert.equal(result.etag, etag);
  }
});

test('a 304 is only sent for the document the route would serve', () => {
  const docs = documents();
  const about = docs.resolve('/about').etag;
  const home = docs.resolve('/').etag;
  const shell = docs.resolve('/nope').etag;
  assert.equal(docs.resolve('/stats', about).status, 200, '/about\'s tag must not validate /stats');
  assert.equal(docs.resolve('/', about).status, 200);
  assert.equal(docs.resolve('/about', home).status, 200);
  assert.equal(docs.resolve('/about', shell).status, 200, 'the shell tag must not validate a prerendered route');
  assert.equal(docs.resolve('/', shell).status, 200);
  assert.equal(docs.resolve('/other', shell).status, 304);
});

test('ifNoneMatchHits never matches a missing ETag', () => {
  assert.equal(ifNoneMatchHits('"a"', undefined), false);
  assert.equal(ifNoneMatchHits('', '"a"'), false);
  assert.equal(ifNoneMatchHits(undefined, '"a"'), false);
  assert.equal(ifNoneMatchHits('"a", "b"', '"b"'), true);
});

test('a missing build serves the placeholder without validators and never throws', () => {
  const placeholder = '<html><body>Build not found. Run npm run build.</body></html>';
  const docs = createHtmlDocuments({ indexHtml: placeholder, withEtags: false });
  for (const pathname of ['/', '/about', '/nope']) {
    const result = docs.resolve(pathname, '"anything"');
    assert.deepEqual(result, { status: 200, html: placeholder, etag: undefined });
  }
  // Before startServer() loads anything.
  const empty = createHtmlDocuments({ withEtags: false });
  assert.deepEqual(empty.resolve('/', undefined), { status: 200, html: undefined, etag: undefined });
  assert.deepEqual(empty.variants(), []);
});

// server.js wiring: the catch-all serves exactly what resolve() chose, and the
// documents are built with injectSsoFlags as the transform.
test('server.js catch-all delegates selection and validators to htmlDocuments', () => {
  const resolveCalls = find(serverAst, node => node.type === 'CallExpression'
    && text(node.callee) === 'htmlDocuments.resolve').map(({ node }) => node);
  assert.equal(resolveCalls.length, 1);
  assert.deepEqual(resolveCalls[0].arguments.map(text), ['pathname', "req.headers['if-none-match']"]);

  const builds = find(serverAst, node => node.type === 'CallExpression' && node.callee.name === 'createHtmlDocuments')
    .map(({ node }) => node.arguments[0]);
  const real = builds.filter(arg => arg.properties.some(p => p.key.name === 'routeHtml'));
  assert.equal(real.length, 1, 'one build from dist/');
  const transform = real[0].properties.find(p => p.key.name === 'transform');
  assert.equal(transform && text(transform.value), 'injectSsoFlags');
  assert.ok(!real[0].properties.some(p => p.key.name === 'withEtags'), 'the real build keeps its ETags');

  const handler = find(serverAst, node => node.type === 'BlockStatement'
    && node.body.some(stmt => stmt.declarations?.[0]?.init && text(stmt.declarations[0].init).startsWith('htmlDocuments.resolve')))[0].node;
  const body = text(handler);
  assert.match(body, /if \(document\.status === 304\) return res\.status\(304\)\.end\(\);/);
  assert.match(body, /res\.send\(document\.html\);/);
  assert.match(body, /if \(document\.etag\) res\.setHeader\('ETag', document\.etag\);/);
});

// Issue #286: the order matters, not just the presence of the three calls. A
// 304 must carry the ETag a 200 would (RFC 9110 15.4.5), so the header has to
// be set before the early 304 return. The handler's own statements after the
// resolve() call are run against a fake res for each outcome.
function catchAllResponder() {
  const handler = find(serverAst, node => node.type === 'BlockStatement'
    && node.body.some(stmt => stmt.declarations?.[0]?.init && text(stmt.declarations[0].init).startsWith('htmlDocuments.resolve')))[0].node;
  const at = handler.body.findIndex(stmt => stmt.declarations?.[0]?.init
    && text(stmt.declarations[0].init).startsWith('htmlDocuments.resolve'));
  const tail = handler.body.slice(at + 1).map(text).join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('document', 'res', tail);
}

function fakeRes() {
  const res = { headers: {}, statusCode: 200, body: undefined, ended: false };
  res.setHeader = (name, value) => {
    if (value === undefined) throw new TypeError(`ERR_HTTP_INVALID_HEADER_VALUE for ${name}`);
    res.headers[name] = value;
    return res;
  };
  res.status = code => { res.statusCode = code; return res; };
  res.end = () => { res.ended = true; return res; };
  res.send = body => { res.body = body; res.ended = true; return res; };
  return res;
}

test('server.js catch-all sends the ETag on 304s and 200s, and none without a build (#286)', () => {
  const respond = catchAllResponder();
  const docs = createHtmlDocuments({ indexHtml: INDEX, homeHtml: HOME, routeHtml: ROUTES });
  const etag = htmlEtag(ROUTES['/about']);

  const notModified = fakeRes();
  respond(docs.resolve('/about', etag), notModified);
  assert.equal(notModified.statusCode, 304);
  assert.equal(notModified.headers.ETag, etag, 'a 304 carries the validator');
  assert.equal(notModified.body, undefined, 'a 304 has no body');
  assert.ok(notModified.ended);

  const fresh = fakeRes();
  respond(docs.resolve('/about', '"stale"'), fresh);
  assert.equal(fresh.statusCode, 200);
  assert.equal(fresh.headers.ETag, etag);
  assert.equal(fresh.body, ROUTES['/about']);

  // No build: no ETag header at all (setHeader(undefined) would throw).
  const missing = fakeRes();
  respond(createHtmlDocuments({ withEtags: false }).resolve('/', undefined), missing);
  assert.equal(missing.statusCode, 200);
  assert.deepEqual(missing.headers, {});
  assert.ok(missing.ended);
});

// Issue #349: the raw build documents were served as static files, skipping
// the SSO flag injection, the strong ETag policy and the per-route rule.
test('raw build HTML URLs redirect to the route that serves that markup', () => {
  assert.equal(buildHtmlRedirect('/index.html'), '/');
  assert.equal(buildHtmlRedirect('/index.prerendered.html'), '/');
  assert.equal(buildHtmlRedirect('/prerendered/about.html'), '/about');
  assert.equal(buildHtmlRedirect('/prerendered/stats.html'), '/stats');
  for (const p of ['/', '/about', '/about.html', '/prerendered/', '/prerendered/a/b.html',
    '/prerendered/..html', '/prerendered/%2e.html', '/assets/x.js', '/x/index.html']) {
    assert.equal(buildHtmlRedirect(p), null, p);
  }
});

test('server.js never serves .html from the static root and redirects raw build URLs first', () => {
  const statics = find(serverAst, node => node.type === 'CallExpression' && node.callee.name === 'staticMiddleware');
  assert.equal(statics.length, 1);
  const options = statics[0].node.arguments[1];
  const skip = options.properties.find(p => p.key.name === 'skipExtensions');
  assert.ok(skip, 'staticMiddleware gets skipExtensions');
  assert.match(text(skip.value), /'\.html'/);
  const redirect = find(serverAst, node => node.type === 'CallExpression' && node.callee.name === 'createStaticRedirectMiddleware');
  assert.equal(redirect.length, 1);
  assert.ok(redirect[0].node.start < statics[0].node.start, 'redirect is registered before static serving');
});
