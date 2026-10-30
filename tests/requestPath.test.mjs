import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

import { requestTargetPath, pathShapeVerdict, createPathShapeMiddleware } from '../server/requestPath.js';
import { createFastifyCompatApp } from '../server/fastifyCompat.js';
import { createMaintenanceMiddleware } from '../server/maintenance.js';
import { classifyRequestPath } from '../server/blockedPaths.js';
import { find, serverAst, text } from './helpers/serverAst.mjs';

// Issue #350: req.path came from new URL(request.url, 'http://localhost'),
// which reads "//about" as host "about" and turns backslashes and dot segments
// into a different path than the one Fastify routes on.
test('requestTargetPath keeps the raw target without authority semantics', () => {
  assert.equal(requestTargetPath('//about'), '//about');
  assert.equal(requestTargetPath('//x/about'), '//x/about');
  assert.equal(requestTargetPath('///'), '///');
  assert.equal(requestTargetPath('/\\about'), '/\\about');
  assert.equal(requestTargetPath('/api/analyze/status/..\\..\\..\\health?x=1'), '/api/analyze/status/..\\..\\..\\health');
  assert.equal(requestTargetPath('/a/../b'), '/a/../b');
  assert.equal(requestTargetPath('/about?x=1#frag'), '/about');
  assert.equal(requestTargetPath('/about#frag'), '/about');
  assert.equal(requestTargetPath(''), '/');
  assert.equal(requestTargetPath('?x=1'), '/');
  // Absolute-form targets are not parsed (issue #358): pathShapeVerdict
  // rejects every target that does not start with "/", so the path only has
  // to be something no route or path-scoped middleware matches.
  assert.equal(requestTargetPath('http://example.com/about?x=1'), 'http://example.com/about');
  assert.equal(requestTargetPath('https://x.y?q/health'), 'https://x.y');
  assert.equal(requestTargetPath('*'), '*');
});

test('pathShapeVerdict: duplicate slashes redirect, backslashes and dot segments are rejected', () => {
  assert.deepEqual(pathShapeVerdict('//about', '//about', 'GET'), { status: 301, location: '/about' });
  assert.deepEqual(pathShapeVerdict('//x/about', '//x/about', 'GET'), { status: 301, location: '/x/about' });
  assert.deepEqual(pathShapeVerdict('///', '///', 'HEAD'), { status: 301, location: '/' });
  assert.deepEqual(pathShapeVerdict('/about//', '/about//?a=1&b=2', 'GET'), { status: 301, location: '/about/?a=1&b=2' });
  assert.deepEqual(pathShapeVerdict('//api/x', '//api/x', 'POST'), { status: 308, location: '/api/x' });
  // Location is built from the raw (still-encoded) target.
  assert.deepEqual(pathShapeVerdict('//über', '//%C3%BCber', 'GET'), { status: 301, location: '/%C3%BCber' });

  for (const p of ['/\\about', '//\\evil.com', '/api/analyze/status/..\\..\\..\\health', '/a/../b', '/a/./b', '/..', '/x/.']) {
    assert.deepEqual(pathShapeVerdict(p, p, 'GET'), { status: 400 }, p);
  }
  for (const p of ['/', '/about', '/about/', '/assets/index-abc.js', '/a..b', '/.well-known/security.txt', '/api/analyze/status/abc.def']) {
    assert.equal(pathShapeVerdict(p, p, 'GET'), null, p);
  }
  // Only origin-form targets are accepted (issue #358).
  for (const raw of ['https://x.y?q/health', 'http://h?/api/forum/related', 'http://example.com/about', 'HTTP://example.com/', '*', '?x=1', 'about']) {
    assert.deepEqual(pathShapeVerdict(requestTargetPath(raw), raw, 'GET'), { status: 400 }, raw);
    assert.deepEqual(pathShapeVerdict(requestTargetPath(raw), raw, 'OPTIONS'), { status: 400 }, raw);
  }
});

test('blockedPaths rejects dot segments hidden behind %2F', () => {
  assert.equal(classifyRequestPath('/x%2F..%2F.git/config'), 'invalid');
  assert.equal(classifyRequestPath('/a/%2e%2e/src/x'), 'invalid');
  assert.equal(classifyRequestPath('/a..b'), null);
});

// Real sockets: light-my-request normalises backslashes and dot segments in
// string URLs, so these requests go over HTTP with the target sent verbatim.
function rawGet(port, target) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: target, method: 'GET' }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function listen(t, app) {
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  t.after(() => app.fastify.close());
  return app.fastify.server.address().port;
}

test('req.path is the raw target: //about is not the home page', async (t) => {
  const app = createFastifyCompatApp({});
  app.use((req, res) => res.json({ path: req.path }));
  const port = await listen(t, app);

  for (const [target, expected] of [['//about', '//about'], ['//x/about', '//x/about'], ['///', '///'],
    ['/\\about', '/\\about'], ['/a/../b', '/a/../b'], ['/%61bout?x=1', '/about']]) {
    const res = await rawGet(port, target);
    assert.equal(JSON.parse(res.body).path, expected, target);
  }
});

// Same gate order as server.js: ingress, maintenance, path shape, then routes.
test('gate order: backslash and dot-segment paths no longer pass as /health', async (t) => {
  const app = createFastifyCompatApp({});
  const reached = [];
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    return res.status(403).send('Forbidden');
  });
  app.use(createMaintenanceMiddleware({ enabled: () => true }));
  app.use(createPathShapeMiddleware());
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/analyze/status/:uid', (req, res) => {
    reached.push(req.params.uid);
    res.status(503).json({ code: 'API_NOT_CONFIGURED' });
  });
  app.use((req, res) => res.status(404).send('catch-all'));
  const port = await listen(t, app);

  assert.equal((await rawGet(port, '/health')).status, 200);
  for (const target of ['/api/analyze/status/..\\..\\..\\health', '/x/../health', '/api/analyze/status/%2e%2e\\health']) {
    const res = await rawGet(port, target);
    assert.equal(res.status, 403, target);
  }
  assert.deepEqual(reached, []);
});

test('path-shape gate redirects duplicate slashes and rejects backslashes over HTTP', async (t) => {
  const app = createFastifyCompatApp({});
  app.use(createPathShapeMiddleware());
  app.use((req, res) => res.status(200).send(`page ${req.path}`));
  const port = await listen(t, app);

  for (const [target, location] of [['//about', '/about'], ['//x/about', '/x/about'], ['///', '/'], ['//about?x=1', '/about?x=1']]) {
    const res = await rawGet(port, target);
    assert.equal(res.status, 301, target);
    assert.equal(res.headers.location, location, target);
  }
  for (const target of ['/\\about', '//\\evil.com', '/%5Cabout', '/a/../about']) {
    assert.equal((await rawGet(port, target)).status, 400, target);
  }
  const ok = await rawGet(port, '/about');
  assert.equal(ok.status, 200);
  assert.equal(ok.body, 'page /about');
});

test('server.js registers the path-shape gate right after the maintenance gate, before any route', () => {
  const uses = find(serverAst, node => node.type === 'CallExpression'
    && node.callee.type === 'MemberExpression' && node.callee.object.name === 'app'
    && ['use', 'get', 'post'].includes(node.callee.property.name));
  const index = uses.findIndex(({ node }) => text(node).startsWith('app.use(createPathShapeMiddleware('));
  assert.ok(index > 0, 'path-shape gate registered');
  assert.match(text(uses[index - 1].node), /^app\.use\(createMaintenanceMiddleware\(/);
  const firstRoute = uses.findIndex(({ node }) => node.callee.property.name !== 'use');
  assert.ok(firstRoute > index, 'gate precedes every route');
});

// Issue #358: find-my-way strips absolute-form with /^https?:\/\/.*?\//, which
// runs past "?" to the first "/", while requestTargetPath stopped the authority
// at "?": "https://x.y?q/health" reached the /health route with req.path "/",
// and "http://h?/api/forum/related" reached the route without
// app.use('/api/', ...) running. Only origin-form targets are accepted now.
function rawRequest(port, method, target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.end(`${method} ${target} HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.setEncoding('latin1');
    socket.on('data', chunk => { data += chunk; });
    socket.on('end', () => {
      const [head, ...rest] = data.split('\r\n\r\n');
      resolve({ status: Number(head.split(' ')[1]), head, body: rest.join('\r\n\r\n') });
    });
    socket.on('error', reject);
  });
}

test('absolute-form and other non-origin-form targets are rejected before any route (server.js gate order)', async (t) => {
  const app = createFastifyCompatApp({});
  const reached = [];
  // CLOUDFLARE_ONLY_INGRESS=false: no ingress gate; maintenance off.
  app.use(createMaintenanceMiddleware({ enabled: () => false }));
  app.use(createPathShapeMiddleware());
  const apiScoped = [];
  app.use('/api/', (req, _res, next) => { apiScoped.push(req.path); next(); });
  app.get('/health', (req, res) => { reached.push(`health ${req.path}`); res.json({ status: 'ok' }); });
  app.get('/api/forum/related', (req, res) => { reached.push(`forum ${req.path}`); res.json({ threads: [] }); });
  app.get('/about', (req, res) => { reached.push(`about ${req.path}`); res.send('about'); });
  app.use((req, res) => { reached.push(`catch-all ${req.path}`); res.status(404).send('catch-all'); });
  const port = await listen(t, app);

  for (const [method, target] of [
    ['GET', 'https://x.y?q/health'],
    ['GET', 'http://h?/api/forum/related'],
    ['GET', 'http://example.com/about'],
    ['GET', 'http://example.com/health'],
    ['HEAD', 'http://example.com/health'],
    ['POST', 'http://h?/api/forum/related'],
    ['OPTIONS', '*']
  ]) {
    const res = await rawRequest(port, method, target);
    assert.equal(res.status, 400, `${method} ${target}`);
  }
  assert.deepEqual(reached, []);
  assert.deepEqual(apiScoped, []);

  // Origin-form still reaches the routes, with the API middleware in front.
  assert.equal((await rawRequest(port, 'GET', '/health')).status, 200);
  assert.equal((await rawRequest(port, 'GET', '/api/forum/related')).status, 200);
  assert.deepEqual(reached, ['health /health', 'forum /api/forum/related']);
  assert.deepEqual(apiScoped, ['/api/forum/related']);
});
