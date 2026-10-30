import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createFileHandleCodec, createSessionCodec } from '../server/sessionToken.js';
import { exchangeSession } from '../server/ssoSession.js';

// Issue #354: the forum SSO re-verification (every 12 min, and on tab focus)
// minted a new session id, so the tab's WinDBG file handles stopped proving
// ownership in the middle of an analysis.
const SECRET = 'test-secret-for-sso-session';
const sessions = createSessionCodec({ secret: SECRET, idleMs: 60 * 60 * 1000, maxAgeMs: 12 * 60 * 60 * 1000 });
const handles = createFileHandleCodec({ secret: SECRET, ttlMs: 12 * 60 * 60 * 1000 });
const FILE_HASH = 'a'.repeat(64);
const REVERIFY_MS = 15 * 60 * 1000;

function createSession() {
  const now = Date.now();
  return { sessionId: crypto.randomBytes(32).toString('hex'), sessionData: { timestamp: now, createdAt: now, turnstileVerified: true } };
}

function cookieFor(sessionData) {
  const { sessionId } = createSession();
  return { sessionId, token: sessions.issue(sessionId, { timestamp: Date.now(), createdAt: Date.now() - 1000, turnstileVerified: true, ...sessionData }) };
}

const member = (uid, tier = 'premium') => ({ uid, tier, username: `user${uid}`, avatar: '' });

function exchange(token, identity) {
  const result = exchangeSession({ presented: token ? sessions.verify(token) : null, identity, createSession, reverifyMs: REVERIFY_MS });
  // What the route then sets as the cookie, and what the next request verifies.
  return { ...result, next: sessions.verify(sessions.issue(result.sessionId, result.sessionData)) };
}

test('re-verifying the same forum user keeps the session id, so an earlier upload handle still proves ownership (#354)', () => {
  const { sessionId, token } = cookieFor({ tier: 'premium', wfUserId: 42, wfUsername: 'user42', tierExpiresAt: Date.now() - 1 });
  const handle = handles.issue({ fileHash: FILE_HASH, jobId: 'job-1', sessionId });

  const result = exchange(token, member(42, 'forum'));
  assert.equal(result.kept, true);
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.next.valid, true);
  assert.equal(result.next.sessionId, sessionId);
  assert.equal(result.next.sessionData.tier, 'forum', 'the tier claim is refreshed');
  assert.ok(result.next.sessionData.tierExpiresAt > Date.now(), 'the re-verification window is renewed');
  assert.equal(handles.verify(handle, { fileHash: FILE_HASH, sessionId: result.next.sessionId })?.jid, 'job-1');
});

test('the forum user id matches across number and string forms (#354)', () => {
  const { sessionId, token } = cookieFor({ tier: 'premium', wfUserId: '42' });
  assert.equal(exchange(token, member(42)).sessionId, sessionId);
});

test('an exchange for a different forum user mints a new session id and the old handle no longer verifies (#354)', () => {
  const { sessionId, token } = cookieFor({ tier: 'premium', wfUserId: 42, wfUsername: 'user42' });
  const handle = handles.issue({ fileHash: FILE_HASH, jobId: 'job-1', sessionId });

  const result = exchange(token, member(7));
  assert.equal(result.kept, false);
  assert.notEqual(result.sessionId, sessionId);
  assert.equal(result.next.sessionData.wfUserId, 7);
  assert.equal(result.next.sessionData.wfUsername, 'user7');
  assert.equal(handles.verify(handle, { fileHash: FILE_HASH, sessionId: result.next.sessionId }), null);
});

test('signing in from an anonymous session rotates the id: a planted session is never upgraded (#354)', () => {
  const { sessionId, token } = cookieFor({});
  const result = exchange(token, member(42));
  assert.equal(result.kept, false);
  assert.notEqual(result.sessionId, sessionId);
  assert.equal(result.next.sessionData.wfUserId, 42);
});

test('no, an invalid, an expired or an unverified session cookie gets a new id (#354)', () => {
  const expiredId = createSession().sessionId;
  const expired = sessions.issue(expiredId, { timestamp: Date.now() - 2 * 60 * 60 * 1000, createdAt: Date.now() - 3 * 60 * 60 * 1000, turnstileVerified: true, wfUserId: 42 });
  const unverified = cookieFor({ wfUserId: 42, turnstileVerified: false });
  const forged = cookieFor({ wfUserId: 42 });
  for (const [label, token, oldId] of [
    ['none', null, null],
    ['expired', expired, expiredId],
    ['unverified', unverified.token, unverified.sessionId],
    ['forged', `${forged.token.split('.')[0]}.${'A'.repeat(43)}`, forged.sessionId]
  ]) {
    const result = exchange(token, member(42));
    assert.equal(result.kept, false, label);
    assert.notEqual(result.sessionId, oldId, label);
    assert.equal(result.next.valid, true, label);
  }
});

test('a kept session carries only the fresh identity, not stale claims from the old cookie (#354)', () => {
  const { token } = cookieFor({ tier: 'premium', wfUserId: 42, wfUsername: 'old-name', wfAvatar: 'https://example.invalid/old.png' });
  const result = exchange(token, { uid: 42, tier: 'forum', username: 'new-name', avatar: '' });
  assert.equal(result.kept, true);
  assert.equal(result.sessionData.wfUsername, 'new-name');
  assert.equal(result.sessionData.wfAvatar, '');
  assert.equal(result.sessionData.turnstileVerified, true);
});

// server.js wiring: the exchange route decides through exchangeSession with
// the presented cookie, issues the cookie for its result, and never mints a
// session on its own.
test('the /api/auth/wf/exchange route issues the session exchangeSession chose (#354)', async () => {
  const { routes, find, text } = await import('./helpers/serverAst.mjs');
  const route = routes('post').find(entry => entry.path === '/api/auth/wf/exchange');
  assert.ok(route, 'the exchange route exists');
  const handler = route.call.arguments.at(-1);
  const calls = name => find(handler, node => node.type === 'CallExpression' && text(node.callee) === name).map(({ node }) => node);

  assert.equal(calls('createSession').length, 0, 'the route does not mint a session itself');
  const [decision] = calls('exchangeSession');
  assert.ok(decision, 'exchangeSession decides the session');
  const props = Object.fromEntries(decision.arguments[0].properties.map(p => [p.key.name, text(p.value)]));
  assert.equal(props.createSession, 'createSession');
  assert.equal(props.identity, 'identity');
  assert.ok(props.presented, 'the presented session is passed');
  const presented = find(handler, node => node.type === 'VariableDeclarator' && node.id.name === props.presented)[0];
  assert.match(text(presented.node.init), /validateSession\(req\.cookies\??\.bsod_session\)/);
  const [issue] = calls('setSessionCookies');
  assert.deepEqual(issue.arguments.slice(1).map(text), ['sessionId', 'sessionData']);
  assert.match(text(handler), /sessionKept: kept/);
});
