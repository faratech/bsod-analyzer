import test from 'node:test';
import assert from 'node:assert/strict';
import { createFastifyCompatApp } from '../server/fastifyCompat.js';

// Issue #289: Fastify routes on the percent-decoded path, so req.path (which
// path-scoped middleware such as app.use('/api/', apiLimiter) matches on) and
// the error format must use the same decoded path.
async function buildApp(t) {
  const app = createFastifyCompatApp({});
  t.after(() => app.fastify.close());
  const seen = [];
  app.use('/api/', (req, _res, next) => {
    seen.push(`apiLimiter:${req.path}`);
    next();
  });
  app.get('/api/stats', (req, res) => res.json({ route: 'stats', path: req.path, originalUrl: req.originalUrl }));
  app.get('/api/boom', () => {
    throw new Error('boom');
  });
  app.post('/api/small', (_req, res) => res.json({ ok: true }));
  app.fastify.addContentTypeParser('application/x-small', { parseAs: 'string', bodyLimit: 16 }, (_r, body, done) => done(null, body));
  app.use((req, res) => res.status(404).json({ route: 'catchall', path: req.path }));
  // Same shape as server.js's error middleware: JSON for /api/, text otherwise.
  app.use((err, req, res, _next) => {
    if (req.path.startsWith('/api/')) {
      return res.status(500).json({ success: false, error: 'An internal server error occurred', code: 'INTERNAL_ERROR' });
    }
    return res.status(500).send(err.stack);
  });
  await app.fastify.ready();
  return { app, seen };
}

test('percent-encoded /api paths run the /api/ middleware with the decoded req.path (#289)', async (t) => {
  const { app, seen } = await buildApp(t);

  for (const url of ['/api/stats', '/%61pi/stats', '/api/%73tats', '/%61%70%69/stats', '/%61pi/stats?x=%61']) {
    seen.length = 0;
    const response = await app.fastify.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 200, url);
    const body = JSON.parse(response.body);
    assert.equal(body.route, 'stats', url);
    assert.equal(body.path, '/api/stats', url);
    assert.equal(body.originalUrl, url, `${url}: originalUrl keeps the raw form`);
    assert.deepEqual(seen, ['apiLimiter:/api/stats'], url);
  }
});

test('reserved escapes stay encoded and malformed escapes do not crash the path (#289)', async (t) => {
  const { app, seen } = await buildApp(t);

  // %2F is not decoded by the router, so this is not the /api/stats route.
  seen.length = 0;
  const slash = await app.fastify.inject({ method: 'GET', url: '/api%2Fstats' });
  assert.equal(slash.statusCode, 404);
  assert.equal(JSON.parse(slash.body).path, '/api%2Fstats');
  assert.deepEqual(seen, []);

  // %25 stays encoded, so it is never double-decoded into /api/.
  seen.length = 0;
  const percent = await app.fastify.inject({ method: 'GET', url: '/%2561pi/stats' });
  assert.equal(percent.statusCode, 404);
  assert.equal(JSON.parse(percent.body).path, '/%2561pi/stats');
  assert.deepEqual(seen, []);

  for (const url of ['/api/%E0%A4%A', '/%61pi/%zz', '/api/%']) {
    const response = await app.fastify.inject({ method: 'GET', url });
    assert.ok(response.statusCode >= 400 && response.statusCode < 500, `${url}: ${response.statusCode}`);
  }
});

test('thrown errors on percent-encoded /api paths keep the JSON error envelope (#289)', async (t) => {
  const { app } = await buildApp(t);

  for (const url of ['/api/boom', '/%61pi/boom', '/api/%62oom']) {
    const response = await app.fastify.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 500, url);
    assert.match(String(response.headers['content-type']), /application\/json/, url);
    const body = JSON.parse(response.body);
    assert.equal(body.success, false, url);
    assert.equal(body.code, 'INTERNAL_ERROR', url);
  }
});

test('Fastify-level errors on percent-encoded /api paths use the JSON envelope (#289)', async (t) => {
  const { app } = await buildApp(t);

  for (const url of ['/api/small', '/%61pi/small']) {
    const response = await app.fastify.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-small' },
      payload: 'x'.repeat(64)
    });
    assert.equal(response.statusCode, 413, url);
    const body = JSON.parse(response.body);
    assert.equal(body.success, false, url);
    assert.equal(body.code, 'REQUEST_TOO_LARGE', url);
  }
});
