import test from 'node:test';
import assert from 'node:assert/strict';

import { createFastifyCompatApp } from '../server/fastifyCompat.js';
import { registerStatsRoute } from '../server/statsRoute.js';

function fakeStore({ initial = null, buildable = true } = {}) {
  let built = 0;
  let cached = initial; // mirrors statsStore: buildSnapshot refreshes the cache
  return {
    getSnapshot: async () => cached,
    buildSnapshot: async () => {
      if (!buildable) return null;
      built += 1;
      cached = { success: true, totals: { analyses: built }, gauges: {}, daily: [] };
      return cached;
    },
    _builds: () => built
  };
}

async function listen(app) {
  await new Promise(resolve => app.listen(0, resolve));
  const address = app.fastify.server.address();
  return { port: address.port, close: () => app.fastify.close() };
}

async function get(port, path, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  const body = res.status === 304 ? '' : await res.text();
  return { status: res.status, headers: res.headers, body };
}

test('GET /api/stats serves snapshot with ETag, Cache-Control and 304 revalidation', async () => {
  const store = fakeStore({ initial: { success: true, totals: { analyses: 42 } } });
  const app = createFastifyCompatApp({ bodyLimit: 1024 });
  registerStatsRoute(app, { store });
  const server = await listen(app);
  try {
    const first = await get(server.port, '/api/stats');
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
    assert.match(first.body, /"analyses":42/);
    const etag = first.headers.get('etag');
    assert.ok(etag && etag.length > 10);

    const revalidated = await get(server.port, '/api/stats', { 'if-none-match': etag });
    assert.equal(revalidated.status, 304);
    assert.equal(revalidated.body, '');

    const changed = await get(server.port, '/api/stats', { 'if-none-match': '"stale-etag"' });
    assert.equal(changed.status, 200);
    // Snapshot was served from cache both times; no rebuild happened.
    assert.equal(store._builds(), 0);
  } finally {
    await server.close();
  }
});

test('cold miss builds the snapshot once; unavailable store yields 503', async () => {
  const cold = fakeStore({ initial: null });
  const app = createFastifyCompatApp({ bodyLimit: 1024 });
  registerStatsRoute(app, { store: cold });
  const server = await listen(app);
  try {
    const res = await get(server.port, '/api/stats');
    assert.equal(res.status, 200);
    assert.equal(cold._builds(), 1);
    const again = await get(server.port, '/api/stats');
    assert.equal(again.status, 200);
    assert.equal(cold._builds(), 1); // cached now
  } finally {
    await server.close();
  }

  const dead = fakeStore({ buildable: false });
  const app2 = createFastifyCompatApp({ bodyLimit: 1024 });
  registerStatsRoute(app2, { store: dead });
  const server2 = await listen(app2);
  try {
    const res = await get(server2.port, '/api/stats');
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.body, /STATS_UNAVAILABLE/);
  } finally {
    await server2.close();
  }
});
