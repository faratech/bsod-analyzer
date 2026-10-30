import test from 'node:test';
import assert from 'node:assert/strict';

import { createFastifyCompatApp } from '../server/fastifyCompat.js';
import { createStaticRedirectMiddleware } from '../server/staticPolicy.js';
import { find, serverAst, text } from './helpers/serverAst.mjs';

// Issue #357: the legacy-location redirect (#348) and the raw build-document
// redirects (#349) lived inline in server.js with no test; breaking either one
// left the suite green.

function appWithRedirects(t) {
  const app = createFastifyCompatApp({});
  app.use(createStaticRedirectMiddleware());
  app.use((req, res) => res.status(200).send(`fallthrough ${req.method} ${req.path}`));
  t.after(() => app.fastify.close());
  return app;
}

test('legacy and build-document URLs 301 to their routes for GET and HEAD, keeping the query where documented', async (t) => {
  const app = appWithRedirects(t);
  const cases = [
    ['/security.txt', '/.well-known/security.txt'],
    ['/index.html', '/'],
    ['/index.html?x=1', '/?x=1'],
    ['/index.html?utm_source=a&utm_medium=b', '/?utm_source=a&utm_medium=b'],
    ['/index.prerendered.html', '/'],
    ['/prerendered/about.html', '/about'],
    ['/prerendered/about.html?ref=x', '/about?ref=x']
  ];
  for (const method of ['GET', 'HEAD']) {
    for (const [url, location] of cases) {
      const res = await app.fastify.inject({ method, url });
      assert.equal(res.statusCode, 301, `${method} ${url}`);
      assert.equal(res.headers.location, location, `${method} ${url}`);
    }
  }
});

test('other methods and other paths fall through', async (t) => {
  const app = appWithRedirects(t);
  for (const [method, url] of [
    ['POST', '/security.txt'],
    ['POST', '/index.html'],
    ['GET', '/.well-known/security.txt'],
    ['GET', '/about'],
    ['GET', '/prerendered/about.json'],
    ['GET', '/assets/index.html.js']
  ]) {
    const res = await app.fastify.inject({ method, url });
    assert.equal(res.statusCode, 200, `${method} ${url}`);
    assert.equal(res.headers.location, undefined, `${method} ${url}`);
  }
});

test('server.js mounts the redirect middleware after the blocked-path gate and before static serving', () => {
  const uses = find(serverAst, node => node.type === 'CallExpression'
    && node.callee.type === 'MemberExpression' && node.callee.object.name === 'app'
    && node.callee.property.name === 'use');
  const redirect = uses.findIndex(({ node }) => text(node) === 'app.use(createStaticRedirectMiddleware())');
  const blocked = uses.findIndex(({ node }) => /classifyRequestPath\(req\.path\)/.test(text(node)));
  const statics = uses.findIndex(({ node }) => text(node).startsWith('app.use(staticMiddleware('));
  assert.ok(redirect >= 0, 'redirect middleware mounted');
  assert.ok(blocked >= 0 && blocked < redirect, 'after the blocked-path gate');
  assert.ok(statics > redirect, 'before static serving');
  // No inline copy left behind in server.js.
  assert.doesNotMatch(text(serverAst), /STATIC_REDIRECTS\[|buildHtmlRedirect\(/);
});
