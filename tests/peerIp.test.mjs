import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPeerIpResolver, buildCloudflareBlockList } from '../server/peerIp.js';

const CF_EDGE = '104.16.0.1';      // inside the published Cloudflare v4 ranges
const CLIENT = '203.0.113.7';      // TEST-NET-3, never routed
const ATTACKER = '192.0.2.9';      // TEST-NET-1

function req({ xff, remote = ATTACKER, cfIp, ip } = {}) {
  const headers = {};
  if (xff !== undefined) headers['x-forwarded-for'] = xff;
  if (cfIp !== undefined) headers['cf-connecting-ip'] = cfIp;
  return { headers, socket: { remoteAddress: remote }, ip };
}

const resolver = createPeerIpResolver({ trustProxyHops: 2 });

test('a full CF->Cloud Run XFF chain is trusted end to end', () => {
  const r = req({ xff: `${CLIENT}, ${CF_EDGE}`, cfIp: CLIENT });
  assert.equal(resolver.hasTrustedXffChain(r), true);
  assert.equal(resolver.getImmediatePeerIp(r), CF_EDGE);
  assert.equal(resolver.isFromCloudflare(r), true);
  assert.equal(resolver.getClientIp(r), CLIENT);
});

test('a short XFF chain is untrusted: the rightmost entry is ignored', () => {
  // Simulates infrastructure that replaces (not appends) X-Forwarded-For: the
  // attacker-supplied entry must not become the peer identity.
  const r = req({ xff: `${CF_EDGE}` });
  assert.equal(resolver.hasTrustedXffChain(r), false);
  assert.equal(resolver.getImmediatePeerIp(r), ATTACKER);
  assert.equal(resolver.isFromCloudflare(r), false);
  // cf-connecting-ip must not be honoured without a trusted chain either.
  const spoof = req({ xff: `${CF_EDGE}`, cfIp: CLIENT });
  assert.equal(resolver.getClientIp(spoof), ATTACKER);
});

test('no XFF at all falls back to the socket address', () => {
  const r = req({});
  assert.equal(resolver.getImmediatePeerIp(r), ATTACKER);
  assert.equal(resolver.isFromCloudflare(r), false);
});

test('getClientIp prefers the socket address over req.ip on untrusted chains', () => {
  const r = req({ xff: `${CF_EDGE}`, ip: CF_EDGE });
  assert.equal(resolver.getClientIp(r), ATTACKER);
});

test('getClientIp still trusts req.ip when the chain length checks out', () => {
  const r = req({ xff: `${ATTACKER}, ${CLIENT}, ${CF_EDGE}`, ip: '198.51.100.1' });
  assert.equal(resolver.getClientIp(r), '198.51.100.1');
});

test('the gate fails closed for non-CF peers even with long chains', () => {
  const r = req({ xff: `${ATTACKER}, ${CLIENT}` });
  assert.equal(resolver.isFromCloudflare(r), false);
});

test('trustProxyHops=1 trusts single-proxy chains (non-production default)', () => {
  const loose = createPeerIpResolver({ trustProxyHops: 1 });
  const r = req({ xff: `${CF_EDGE}` });
  assert.equal(loose.hasTrustedXffChain(r), true);
  assert.equal(loose.getImmediatePeerIp(r), CF_EDGE);
  assert.equal(loose.isFromCloudflare(r), true);
});

test('IPv6-mapped socket addresses are normalized before the range check', () => {
  const strict = createPeerIpResolver({ trustProxyHops: 1 });
  const r = req({ xff: '::ffff:' + CF_EDGE });
  assert.equal(strict.isFromCloudflare(r), true);
});

test('the default block list covers the published Cloudflare ranges', () => {
  const blockList = buildCloudflareBlockList();
  assert.equal(blockList.check('104.16.0.1', 'ipv4'), true);
  assert.equal(blockList.check('2400:cb00::1', 'ipv6'), true);
  assert.equal(blockList.check('203.0.113.7', 'ipv4'), false);
});
