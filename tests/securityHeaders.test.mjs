import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CSP_HEADER,
  CSP_EMBED_HEADER,
  createSecurityHeadersMiddleware
} from '../server/securityHeaders.js';
import { createFastifyCompatApp } from '../server/fastifyCompat.js';

function buildApp(middleware) {
  const app = createFastifyCompatApp({ bodyLimit: 1024 });
  app.use(middleware);
  // NOTE: every path we fetch must be registered — unmatched requests under
  // the compat layer hang instead of 404ing.
  app.get('/about', (_req, res) => res.status(200).send('about'));
  app.get('/analyzer', (_req, res) => res.status(200).send('analyzer'));
  app.get('/stats', (_req, res) => res.status(200).send('stats'));
  app.get('/stats/embed', (_req, res) => res.status(200).send('embed'));
  app.get('/stats/embed/x', (_req, res) => res.status(200).send('embed-sub'));
  return app;
}

function headersOf(res) {
  return {
    xfo: res.headers.get('x-frame-options'),
    csp: res.headers.get('content-security-policy')
  };
}

async function listenCompat(app) {
  await new Promise(resolve => app.listen(0, resolve));
  const address = app.fastify.server.address();
  return { port: address.port, close: () => app.fastify.close() };
}

test('default paths keep SAMEORIGIN and strict frame-ancestors', async () => {
  const server = await listenCompat(buildApp(createSecurityHeadersMiddleware()));
  try {
    for (const path of ['/about', '/analyzer']) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { connection: 'close' } });
      assert.equal(res.status, 200);
      const { xfo, csp } = headersOf(res);
      assert.equal(xfo, 'SAMEORIGIN', path);
      // frame-ancestors must be exactly 'self' — no forum origins.
      assert.match(csp, /frame-ancestors 'self'(;|$)/, path);
      assert.doesNotMatch(csp, /frame-ancestors[^;]*windowsforum/, path);
    }
  } finally {
    await server.close();
  }
});

test('only the embed route drops XFO and widens frame-ancestors', async () => {
  const server = await listenCompat(buildApp(createSecurityHeadersMiddleware()));
  try {
    const opts = { headers: { connection: 'close' } };
    const embed = await fetch(`http://127.0.0.1:${server.port}/stats/embed`, opts);
    assert.equal(embed.status, 200);
    const { xfo, csp } = headersOf(embed);
    assert.equal(xfo, null);
    assert.match(csp, /frame-ancestors 'self' https:\/\/windowsforum\.com https:\/\/\*\.windowsforum\.com/);
    assert.match(csp, /frame-ancestors 'self' https:\/\/windowsforum\.com https:\/\/\*\.windowsforum\.com/);
    // Subpaths of an embeddable route stay embeddable.
    const sub = await fetch(`http://127.0.0.1:${server.port}/stats/embed/x`, opts);
    assert.equal(sub.status, 200);
    assert.equal(headersOf(sub).xfo, null);
    // Everything else stays locked down.
    const other = await fetch(`http://127.0.0.1:${server.port}/stats`, opts);
    assert.equal(other.status, 200);
    assert.equal(headersOf(other).xfo, 'SAMEORIGIN');
  } finally {
    await server.close();
  }
});
