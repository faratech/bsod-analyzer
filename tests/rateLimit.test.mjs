import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryRateLimitStore, createRateLimiterFactory, normalizeRateLimitIp } from '../server/rateLimit.js';

function fakeRes() {
  const headers = {};
  return {
    headers,
    statusCode: 200,
    setHeader(name, value) { headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

async function run(limiter, req) {
  const res = fakeRes();
  let passed = false;
  await limiter(req, res, () => { passed = true; });
  return { res, passed };
}

test('limiter allows up to max per key, then answers 429', async () => {
  const makeLimiter = createRateLimiterFactory({ defaultKeyGenerator: req => req.ip });
  const limiter = makeLimiter({ windowMs: 60_000, max: 2, name: 'test' });

  assert.equal((await run(limiter, { ip: '1.1.1.1' })).passed, true);
  assert.equal((await run(limiter, { ip: '1.1.1.1' })).passed, true);
  const third = await run(limiter, { ip: '1.1.1.1' });
  assert.equal(third.passed, false);
  assert.equal(third.res.statusCode, 429);
  assert.equal(third.res.headers['RateLimit-Remaining'], '0');

  // Other keys are independent.
  assert.equal((await run(limiter, { ip: '2.2.2.2' })).passed, true);
});

test('windows reset after windowMs', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const store = createMemoryRateLimitStore(1000);
  assert.equal((await store.increment('k')).totalHits, 1);
  assert.equal((await store.increment('k')).totalHits, 2);
  t.mock.timers.tick(1001);
  assert.equal((await store.increment('k')).totalHits, 1);
});

test('expired keys are swept periodically, not on every increment', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const store = createMemoryRateLimitStore(1000, { sweepIntervalMs: 5000 });
  await store.increment('a');
  await store.increment('b');
  t.mock.timers.tick(2000);
  await store.increment('c'); // a/b expired, but the next sweep is not due yet
  assert.equal(store.size(), 3);
  t.mock.timers.tick(3500);
  await store.increment('d');
  assert.equal(store.size(), 1);
});

test('normalizeRateLimitIp groups IPv6 clients by /64 and keeps IPv4 exact', () => {
  assert.equal(normalizeRateLimitIp('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(normalizeRateLimitIp('2001:DB8:1:2::9'), '2001:db8:1:2::/64');
  assert.equal(normalizeRateLimitIp('2001:0db8:0001:0002:ffff::1'), '2001:db8:1:2::/64');
  assert.notEqual(normalizeRateLimitIp('2001:db8:1:3::1'), normalizeRateLimitIp('2001:db8:1:2::1'));
  assert.equal(normalizeRateLimitIp('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(normalizeRateLimitIp('203.0.113.7, 10.0.0.1'), '203.0.113.7');
  assert.equal(normalizeRateLimitIp(''), 'unknown');
});
