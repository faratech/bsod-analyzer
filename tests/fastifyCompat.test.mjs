import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http2 from 'node:http2';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import fastifyMultipart from '@fastify/multipart';
import {
  createFastifyCompatApp,
  jsonParser,
  staticMiddleware
} from '../server/fastifyCompat.js';
import { createUploadHandler } from '../server/uploadHandler.js';

function rawPayload(response) {
  return Buffer.isBuffer(response.rawPayload)
    ? response.rawPayload
    : Buffer.from(response.payload, 'binary');
}

function zstdPayload(response) {
  return zlib.zstdDecompressSync(rawPayload(response)).toString('utf8');
}

function h2Request(client, {
  method = 'GET',
  path = '/',
  headers = {},
  body = null
}) {
  return new Promise((resolve, reject) => {
    const req = client.request({
      ':method': method,
      ':path': path,
      ...headers
    });
    const chunks = [];
    let responseHeaders;

    req.on('response', headers => {
      responseHeaders = headers;
    });
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      resolve({
        statusCode: Number(responseHeaders?.[':status']),
        headers: responseHeaders || {},
        body: Buffer.concat(chunks)
      });
    });
    req.on('error', reject);

    if (body) req.end(body);
    else req.end();
  });
}

async function listenCompat(app) {
  await new Promise(resolve => app.listen(0, resolve));
  const address = app.fastify.server.address();
  return address.port;
}

test('Fastify compat stack preserves route-level JSON parsing and errors', async () => {
  const app = createFastifyCompatApp({ bodyLimit: 1024 });
  app.post('/api/echo', jsonParser({ limit: '1kb' }), (req, res) => {
    res.json({ body: req.body });
  });
  app.use((error, req, res, _next) => {
    res.status(error.type === 'entity.parse.failed' ? 400 : 500).json({
      success: false,
      code: error.type || 'UNKNOWN'
    });
  });

  try {
    const valid = await app.fastify.inject({
      method: 'POST',
      url: '/api/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"ok":true}'
    });
    assert.equal(valid.statusCode, 200);
    assert.deepEqual(JSON.parse(valid.payload), { body: { ok: true } });

    const invalid = await app.fastify.inject({
      method: 'POST',
      url: '/api/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{bad'
    });
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(JSON.parse(invalid.payload), {
      success: false,
      code: 'entity.parse.failed'
    });
  } finally {
    await app.fastify.close();
  }
});

test('Fastify compat stack serves static files and rejects traversal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bsod-fastify-static-'));
  await fs.writeFile(path.join(root, 'asset.txt'), 'hello static');

  const app = createFastifyCompatApp();
  app.use(staticMiddleware(root, {
    maxAge: '1y',
    setHeaders: res => res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  }));
  app.use((req, res) => res.status(404).send('not found'));

  try {
    const found = await app.fastify.inject({ method: 'GET', url: '/asset.txt' });
    assert.equal(found.statusCode, 200);
    assert.equal(found.headers['content-type'], 'text/plain; charset=utf-8');
    assert.match(found.headers['cache-control'], /max-age=31536000/);
    assert.equal(found.payload, 'hello static');

    const traversal = await app.fastify.inject({ method: 'GET', url: '/../package.json' });
    assert.equal(traversal.statusCode, 404);
  } finally {
    await app.fastify.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Fastify compat stack negotiates zstd for legacy JSON responses', async (t) => {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    t.skip('Node runtime does not support zstd');
    return;
  }

  const app = createFastifyCompatApp({
    compression: {
      enabled: true,
      threshold: 1
    }
  });
  const payload = { message: 'zstd '.repeat(100) };
  app.get('/api/payload', (_req, res) => res.json(payload));

  try {
    const response = await app.fastify.inject({
      method: 'GET',
      url: '/api/payload',
      headers: { 'accept-encoding': 'gzip;q=0.5, zstd;q=1' }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-encoding'], 'zstd');
    assert.match(response.headers.vary, /Accept-Encoding/);
    assert.deepEqual(JSON.parse(zstdPayload(response)), payload);
  } finally {
    await app.fastify.close();
  }
});

test('Fastify compat stack serves h2c requests for health, JSON, static, compression, and multipart', async (t) => {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    t.skip('Node runtime does not support zstd');
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bsod-h2c-static-'));
  await fs.writeFile(path.join(root, 'asset.txt'), 'hello h2c');

  const upload = createUploadHandler({
    limits: { fileSize: 1024, files: 1 },
    fileFilter: (_req, _file, cb) => cb(null, true)
  });
  const app = createFastifyCompatApp({
    http2: true,
    bodyLimit: 16 * 1024,
    compression: {
      enabled: true,
      threshold: 1
    }
  });
  app.fastify.register(fastifyMultipart);
  app.get('/health', (req, res) => {
    res.set({ 'Cache-Control': 'no-store, max-age=0' });
    res.json({ ok: true, httpVersion: req.httpVersion, ip: req.ip });
  });
  app.post('/api/echo', jsonParser({ limit: '1kb' }), (req, res) => {
    res.json({ body: req.body, httpVersion: req.httpVersion });
  });
  app.use(staticMiddleware(root, {
    maxAge: '1y',
    setHeaders: res => res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  }));
  app.post('/api/upload', upload.single('file'), (req, res) => {
    res.json({
      name: req.file?.originalname,
      size: req.file?.size,
      uid: req.body?.uid,
      httpVersion: req.httpVersion
    });
  });

  let client;
  try {
    const port = await listenCompat(app);
    client = http2.connect(`http://127.0.0.1:${port}`);

    const health = await h2Request(client, { path: '/health' });
    assert.equal(health.statusCode, 200);
    assert.equal(health.headers['cache-control'], 'no-store, max-age=0');
    const healthBody = JSON.parse(health.body.toString('utf8'));
    assert.equal(healthBody.ok, true);
    assert.match(healthBody.httpVersion, /^2/);

    const echo = await h2Request(client, {
      method: 'POST',
      path: '/api/echo',
      headers: {
        'content-type': 'application/json',
        'accept-encoding': 'gzip;q=0.5, zstd;q=1'
      },
      body: Buffer.from('{"ok":true}')
    });
    assert.equal(echo.statusCode, 200);
    assert.equal(echo.headers['content-encoding'], 'zstd');
    assert.equal(echo.headers.connection, undefined);
    assert.equal(echo.headers['transfer-encoding'], undefined);
    assert.deepEqual(JSON.parse(zlib.zstdDecompressSync(echo.body).toString('utf8')), {
      body: { ok: true },
      httpVersion: '2.0'
    });

    const staticAsset = await h2Request(client, { path: '/asset.txt' });
    assert.equal(staticAsset.statusCode, 200);
    assert.equal(staticAsset.headers['content-type'], 'text/plain; charset=utf-8');
    assert.match(staticAsset.headers['cache-control'], /max-age=31536000/);
    assert.equal(staticAsset.body.toString('utf8'), 'hello h2c');

    const boundary = 'bsodtestboundary';
    const multipartBody = Buffer.from([
      `--${boundary}`,
      'Content-Disposition: form-data; name="uid"',
      '',
      'abc123',
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="mini.dmp"',
      'Content-Type: application/octet-stream',
      '',
      'dumpdata',
      `--${boundary}--`,
      ''
    ].join('\r\n'));
    const uploadResponse = await h2Request(client, {
      method: 'POST',
      path: '/api/upload',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(multipartBody.length)
      },
      body: multipartBody
    });
    assert.equal(uploadResponse.statusCode, 200);
    assert.deepEqual(JSON.parse(uploadResponse.body.toString('utf8')), {
      name: 'mini.dmp',
      size: 8,
      uid: 'abc123',
      httpVersion: '2.0'
    });
  } finally {
    client?.close();
    await app.fastify.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Fastify compat stack can force zstd regardless of Accept-Encoding', async (t) => {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    t.skip('Node runtime does not support zstd');
    return;
  }

  const app = createFastifyCompatApp({
    compression: {
      enabled: true,
      threshold: 1024,
      forceThreshold: 0,
      forceEncoding: () => 'zstd'
    }
  });
  const payload = { forced: true };
  app.get('/api/forced', (_req, res) => res.json(payload));

  try {
    const response = await app.fastify.inject({
      method: 'GET',
      url: '/api/forced',
      headers: { 'accept-encoding': 'gzip;q=1, zstd;q=0' }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-encoding'], 'zstd');
    assert.deepEqual(JSON.parse(zstdPayload(response)), payload);
  } finally {
    await app.fastify.close();
  }
});
