import test from 'node:test';
import assert from 'node:assert/strict';
import fastifyCors from '@fastify/cors';

import { allowedCorsOrigins, createCorsOriginCheck } from '../server/corsPolicy.js';
import { createFastifyCompatApp } from '../server/fastifyCompat.js';

const PROD = { NODE_ENV: 'production' };

// Mirrors server.js: @fastify/cors registered once for every route. Compat
// routes hijack the reply, so only the plugin's own preflight responses carry
// its headers, and the preflight is what decides whether a browser sends a
// credentialed JSON POST (e.g. /api/auth/wf/exchange) cross-origin at all.
async function listenWithCors(env) {
  const app = createFastifyCompatApp({ bodyLimit: 1024 });
  app.fastify.register(fastifyCors, {
    origin: createCorsOriginCheck({ env, warn: () => {} }),
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });
  app.post('/api/auth/wf/exchange', (_req, res) => res.status(200).json({ success: true }));
  // server.js ends with a catch-all; without one, unmatched requests hang.
  app.use((_req, res) => res.status(404).send('not found'));
  await new Promise(resolve => app.listen(0, resolve));
  const { port } = app.fastify.server.address();
  return { base: `http://127.0.0.1:${port}`, close: () => app.fastify.close() };
}

function preflight(base, origin) {
  return fetch(`${base}/api/auth/wf/exchange`, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
      connection: 'close',
    },
    signal: AbortSignal.timeout(5000),
  });
}

test('forum origins are refused credentialed CORS (issue #139)', async () => {
  const server = await listenWithCors(PROD);
  try {
    for (const origin of ['https://windowsforum.com', 'https://www.windowsforum.com']) {
      const res = await preflight(server.base, origin);
      assert.equal(res.headers.get('access-control-allow-origin'), null, origin);
      assert.equal(res.headers.get('access-control-allow-credentials'), null, origin);
    }
  } finally {
    await server.close();
  }
});

test('the app origin keeps its credentialed grant', async () => {
  const server = await listenWithCors(PROD);
  try {
    const origin = 'https://bsod.windowsforum.com';
    const res = await preflight(server.base, origin);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), origin);
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
  } finally {
    await server.close();
  }
});

test('allowedCorsOrigins: dev origins only outside production, env additions honored', () => {
  assert.deepEqual(allowedCorsOrigins(PROD), ['https://bsod.windowsforum.com']);
  assert.ok(allowedCorsOrigins({ NODE_ENV: 'development' }).includes('http://localhost:5173'));
  assert.deepEqual(
    allowedCorsOrigins({ ...PROD, PRODUCTION_URL: 'https://a.example', ALLOWED_ORIGINS: ' https://b.example , ,https://c.example' }),
    ['https://a.example', 'https://b.example', 'https://c.example', 'https://bsod.windowsforum.com']
  );
});

test('createCorsOriginCheck: no Origin allowed, file:// only in development', () => {
  const decide = (env, origin) => {
    let result;
    createCorsOriginCheck({ env, warn: () => {} })(origin, (_err, allow) => { result = allow; });
    return result;
  };
  assert.equal(decide(PROD, undefined), true);
  assert.equal(decide(PROD, 'file://x'), false);
  assert.equal(decide({ NODE_ENV: 'development' }, 'file://x'), true);
  assert.equal(decide(PROD, 'https://evil.example'), false);
});
