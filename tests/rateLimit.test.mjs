import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRateLimitIp } from '../server/rateLimit.js';

test('normalizeRateLimitIp keeps IPv4 addresses as exact rate limit keys', () => {
  assert.equal(normalizeRateLimitIp('203.0.113.10'), '203.0.113.10');
  assert.equal(normalizeRateLimitIp('::ffff:203.0.113.10'), '203.0.113.10');
});

test('normalizeRateLimitIp aggregates IPv6 addresses by /64 prefix', () => {
  const first = normalizeRateLimitIp('2001:db8:abcd:1234:1111:2222:3333:4444');
  const rotated = normalizeRateLimitIp('2001:db8:abcd:1234:aaaa:bbbb:cccc:dddd');

  assert.equal(first, '2001:db8:abcd:1234::/64');
  assert.equal(rotated, first);
});

test('normalizeRateLimitIp expands compressed IPv6 before aggregating', () => {
  assert.equal(
    normalizeRateLimitIp('2001:db8:0:1::dead:beef'),
    '2001:db8:0:1::/64'
  );
  assert.equal(normalizeRateLimitIp('::1'), '0:0:0:0::/64');
});

test('normalizeRateLimitIp preserves non-IP fallback keys', () => {
  assert.equal(normalizeRateLimitIp('unknown'), 'unknown');
  assert.equal(normalizeRateLimitIp(''), 'unknown');
});
