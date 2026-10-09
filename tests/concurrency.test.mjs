import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createConcurrencyLimiter } from '../server/concurrency.js';
import { createFastifyCompatApp, onRequestSettled } from '../server/fastifyCompat.js';

function fakeRes() {
  const res = new EventEmitter();
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; return res; };
  return res;
}

test('a client disconnect does not free the slot while the handler still runs', () => {
  const settle = [];
  const limiter = createConcurrencyLimiter(1, 'BUSY', { onSettled: (_req, fn) => settle.push(fn) });
  let calls = 0;
  const next = () => { calls += 1; };

  const first = fakeRes();
  limiter({}, first, next);
  assert.equal(limiter.inFlight(), 1);

  first.emit('close'); // client went away; the handler is still extracting
  assert.equal(limiter.inFlight(), 1);

  const second = fakeRes();
  limiter({}, second, next);
  assert.equal(second.statusCode, 429);
  assert.equal(second.body.code, 'BUSY');
  assert.equal(calls, 1);

  settle[0](); // handler chain settled
  assert.equal(limiter.inFlight(), 0);
  settle[0](); // idempotent
  first.emit('finish');
  assert.equal(limiter.inFlight(), 0);
});

test('tryAcquire hands out slots up to the cap and releases once', () => {
  const limiter = createConcurrencyLimiter(2, 'ANALYSIS_BUSY', { onSettled: () => {} });
  const first = limiter.tryAcquire();
  const second = limiter.tryAcquire();
  assert.equal(typeof first, 'function');
  assert.equal(limiter.tryAcquire(), null);
  first();
  first();
  assert.equal(limiter.inFlight(), 1);
  assert.equal(typeof limiter.tryAcquire(), 'function');
  second();
});

test('a finished response frees the slot', () => {
  const limiter = createConcurrencyLimiter(1, 'BUSY', { onSettled: () => {} });
  const res = fakeRes();
  limiter({}, res, () => {});
  res.emit('finish');
  assert.equal(limiter.inFlight(), 0);
});

test('onRequestSettled fires only after the async handler has finished', async () => {
  const app = createFastifyCompatApp();
  const events = [];
  app.get('/work', (req, _res, next) => {
    onRequestSettled(req, () => events.push('settled'));
    next();
  }, async (_req, res) => {
    res.json({ ok: true });
    await new Promise(resolve => setTimeout(resolve, 20));
    events.push('handler-done');
  });
  try {
    const response = await app.fastify.inject({ method: 'GET', url: '/work' });
    assert.equal(response.statusCode, 200);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(events, ['handler-done', 'settled']);
  } finally {
    await app.fastify.close();
  }
});
