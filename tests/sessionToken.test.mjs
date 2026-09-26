import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFileHandleCodec,
  createSessionCodec,
  createSigner,
  sessionTag
} from '../server/sessionToken.js';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const SID = 'a'.repeat(64);
const HOUR = 60 * 60 * 1000;
const HASH = '0123456789abcdef';

function sessionCodec(overrides = {}) {
  return createSessionCodec({ secret: SECRET, idleMs: HOUR, maxAgeMs: 12 * HOUR, ...overrides });
}

function freshSession(now) {
  return { createdAt: now, timestamp: now, turnstileVerified: true };
}

test('session tokens round-trip the session id and data', () => {
  const codec = sessionCodec();
  const now = Date.now();
  const token = codec.issue(SID, { ...freshSession(now), tier: 'premium', wfUserId: 7, tierExpiresAt: now + 1000 });

  const result = codec.verify(token, now);
  assert.equal(result.valid, true);
  assert.equal(result.sessionId, SID);
  assert.deepEqual(result.sessionData, {
    createdAt: now,
    timestamp: now,
    turnstileVerified: true,
    tier: 'premium',
    wfUserId: 7,
    tierExpiresAt: now + 1000
  });
});

test('tampered payloads and signatures are rejected', () => {
  const codec = sessionCodec();
  const now = Date.now();
  const token = codec.issue(SID, freshSession(now));
  const [payload, mac] = token.split('.');

  const forged = Buffer.from(JSON.stringify({
    ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
    tier: 'premium'
  })).toString('base64url');
  assert.equal(codec.verify(`${forged}.${mac}`, now).valid, false);
  assert.equal(codec.verify(`${payload}.${mac.slice(0, -2)}AA`, now).valid, false);
  assert.equal(codec.verify(`${payload}`, now).valid, false);
  assert.equal(codec.verify(`${payload}.${mac}.extra`, now).valid, false);
  assert.equal(codec.verify(undefined, now).valid, false);
});

test('a different secret cannot verify, but the previous secret can during rotation', () => {
  const now = Date.now();
  const oldToken = sessionCodec({ secret: 'old-secret' }).issue(SID, freshSession(now));

  assert.equal(sessionCodec().verify(oldToken, now).valid, false);
  assert.equal(sessionCodec({ previousSecret: 'old-secret' }).verify(oldToken, now).valid, true);
});

test('idle expiry, absolute lifetime and future timestamps are enforced', () => {
  const codec = sessionCodec();
  const now = Date.now();

  const idle = codec.issue(SID, freshSession(now - 2 * HOUR));
  assert.deepEqual(codec.verify(idle, now), { valid: false, reason: 'Session expired' });

  const tooOld = codec.issue(SID, { createdAt: now - 13 * HOUR, timestamp: now, turnstileVerified: true });
  assert.deepEqual(codec.verify(tooOld, now), { valid: false, reason: 'Session expired' });

  const future = codec.issue(SID, freshSession(now + 5 * 60 * 1000));
  assert.deepEqual(codec.verify(future, now), { valid: false, reason: 'Invalid session' });
});

test('malformed session ids and oversized tokens are rejected', () => {
  const codec = sessionCodec();
  const now = Date.now();
  assert.equal(codec.verify(codec.issue('not-a-session-id', freshSession(now)), now).valid, false);
  assert.equal(codec.verify('x'.repeat(4096), now).valid, false);
});

test('signing purposes are separated', () => {
  const now = Date.now();
  const handle = createFileHandleCodec({ secret: SECRET, ttlMs: HOUR })
    .issue({ fileHash: HASH, sessionId: SID }, now);
  assert.equal(sessionCodec().verify(handle, now).valid, false);

  const generic = createSigner({ secret: SECRET, purpose: 'other' }).sign({ v: 2, sid: SID });
  assert.equal(sessionCodec().verify(generic, now).valid, false);
});

test('file handles prove ownership only for the issuing session and file', () => {
  const codec = createFileHandleCodec({ secret: SECRET, ttlMs: HOUR });
  const now = Date.now();
  const handle = codec.issue({ fileHash: HASH, jobId: 'job-42', sessionId: SID }, now);

  const claims = codec.verify(handle, { fileHash: HASH, sessionId: SID }, now);
  assert.equal(claims.jid, 'job-42');
  assert.equal(claims.st, sessionTag(SID));

  assert.equal(codec.verify(handle, { fileHash: 'fedcba9876543210', sessionId: SID }, now), null);
  assert.equal(codec.verify(handle, { fileHash: HASH, sessionId: 'b'.repeat(64) }, now), null);
  assert.equal(codec.verify(handle, { fileHash: HASH, sessionId: SID }, now + 2 * HOUR), null);
});

test('cache-hit handles carry no job id', () => {
  const codec = createFileHandleCodec({ secret: SECRET, ttlMs: HOUR });
  const now = Date.now();
  const claims = codec.verify(codec.issue({ fileHash: HASH, sessionId: SID }, now), { fileHash: HASH, sessionId: SID }, now);
  assert.ok(claims);
  assert.equal(claims.jid, undefined);
});
