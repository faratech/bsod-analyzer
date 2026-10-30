import test from 'node:test';
import assert from 'node:assert/strict';
import fastifyMultipart from '@fastify/multipart';
import { createFastifyCompatApp, jsonParser } from '../server/fastifyCompat.js';
import { createUploadHandler } from '../server/uploadHandler.js';

const MB = 1024 * 1024;
const BOUNDARY = '----BodyParsingBoundary1234';

function multipartBody(fileLen) {
  const head = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.dmp"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const tail = `\r\n--${BOUNDARY}--\r\n`;
  return Buffer.concat([Buffer.from(head), Buffer.alloc(fileLen, 0x4d), Buffer.from(tail)]);
}

function describeBody(req) {
  const parsed = req.fastifyRequest?.body;
  return {
    bodyType: typeof req.body,
    bodyLength: typeof req.body === 'string' ? req.body.length : null,
    fastifyBodyType: typeof parsed,
    fastifyBodyIsStream: !!parsed && typeof parsed.pipe === 'function'
  };
}

// Issue #288: no default Fastify parser may buffer a body before the
// Express-style stack (ingress gate, limiters, requireSession) has run.
test('text/plain and unknown content types are not buffered before requireSession (#288)', async (t) => {
  // Production passed the 150 MB upload cap as the global limit; even then no
  // body may be read before the middleware stack decides.
  const app = createFastifyCompatApp({ bodyLimit: 150 * MB });
  t.after(() => app.fastify.close());
  const seen = [];
  const requireSession = (req, res) => {
    seen.push(describeBody(req));
    res.status(401).json({ success: false, code: 'NO_SESSION' });
  };
  app.post('/api/gemini/generateContent', requireSession, (_req, res) => res.json({ reached: true }));
  app.use((req, res) => {
    seen.push(describeBody(req));
    res.status(404).json({ success: false, code: 'NOT_FOUND' });
  });
  await app.fastify.ready();

  const big = await app.fastify.inject({
    method: 'POST',
    url: '/api/gemini/generateContent',
    headers: { 'content-type': 'text/plain' },
    payload: 'A'.repeat(120 * MB)
  });
  assert.equal(big.statusCode, 401);
  assert.equal(JSON.parse(big.body).code, 'NO_SESSION');
  assert.equal(seen.length, 1);
  assert.notEqual(seen[0].bodyType, 'string', 'text/plain body must not be buffered into a string');
  assert.equal(seen[0].bodyLength, null);
  assert.equal(seen[0].fastifyBodyIsStream, true, 'the raw stream must be passed through unread');

  for (const contentType of ['text/plain; charset=utf-8', 'application/x-www-form-urlencoded', 'application/octet-stream', 'text/html']) {
    seen.length = 0;
    const routed = await app.fastify.inject({
      method: 'POST',
      url: '/api/gemini/generateContent',
      headers: { 'content-type': contentType },
      payload: 'x'.repeat(2048)
    });
    assert.equal(routed.statusCode, 401, contentType);
    assert.equal(seen.length, 1, contentType);
    assert.notEqual(seen[0].bodyType, 'string', contentType);
    assert.equal(seen[0].fastifyBodyIsStream, true, contentType);
  }

  seen.length = 0;
  const unknown = await app.fastify.inject({
    method: 'POST',
    url: '/nonexistent',
    headers: { 'content-type': 'text/plain' },
    payload: 'x'.repeat(4096)
  });
  assert.equal(unknown.statusCode, 404);
  assert.equal(seen.length, 1);
  assert.notEqual(seen[0].bodyType, 'string');
  assert.equal(seen[0].fastifyBodyIsStream, true);
});

test('application/json keeps route-level parsing after requireSession (#288)', async (t) => {
  const app = createFastifyCompatApp({ bodyLimit: 64 * 1024 });
  t.after(() => app.fastify.close());
  const parse = jsonParser({ limit: '1mb' });
  app.post('/api/echo', (req, _res, next) => {
    req.preParseBodyType = typeof req.body;
    next();
  }, parse, (req, res) => res.json({ pre: req.preParseBodyType, body: req.body }));
  await app.fastify.ready();

  const ok = await app.fastify.inject({
    method: 'POST',
    url: '/api/echo',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ hello: 'world', pad: 'p'.repeat(100 * 1024) })
  });
  assert.equal(ok.statusCode, 200);
  const body = JSON.parse(ok.body);
  assert.equal(body.body.hello, 'world');
  assert.notEqual(body.pre, 'string');
});

test('only routes given a route-level body limit accept large bodies; multipart uploads still work (#288)', async (t) => {
  const app = createFastifyCompatApp({
    bodyLimit: 1024,
    routeBodyLimits: { '/api/windbg/upload': 150 * MB }
  });
  t.after(() => app.fastify.close());
  app.fastify.register(fastifyMultipart, { limits: { fileSize: 100 * MB, files: 1, fields: 20, parts: 25 } });
  const upload = createUploadHandler({
    limits: { fileSize: 100 * MB, files: 1 },
    fileFilter: (_req, _file, cb) => cb(null, true)
  });
  app.post('/api/windbg/upload', upload.single('file'), (req, res) => {
    res.json({ size: req.file?.size ?? null, limit: req.fastifyRequest.routeOptions.bodyLimit });
  });
  app.post('/api/other', (req, res) => res.json({ limit: req.fastifyRequest.routeOptions.bodyLimit }));
  await app.fastify.ready();

  const uploaded = await app.fastify.inject({
    method: 'POST',
    url: '/api/windbg/upload',
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: multipartBody(2 * MB)
  });
  assert.equal(uploaded.statusCode, 200, uploaded.body);
  assert.deepEqual(JSON.parse(uploaded.body), { size: 2 * MB, limit: 150 * MB });

  const other = await app.fastify.inject({ method: 'POST', url: '/api/other' });
  assert.equal(other.statusCode, 200);
  assert.equal(JSON.parse(other.body).limit, 1024);
});
