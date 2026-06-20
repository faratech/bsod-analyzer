import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createFastifyCompatApp,
  jsonParser,
  staticMiddleware
} from '../server/fastifyCompat.js';

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
