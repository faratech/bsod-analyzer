import test from 'node:test';
import assert from 'node:assert/strict';

import { ALL_SESSION_COOKIES, presentedSessionCookies } from '../server/sessionCookies.js';

const names = cookies => cookies.map(c => c.name);

test('a request that presented no session cookie clears nothing (issue #141)', () => {
  // A cross-site form POST arrives without any SameSite=Lax cookie.
  assert.deepEqual(presentedSessionCookies({}), []);
  assert.deepEqual(presentedSessionCookies({ unrelated: '1' }), []);
  assert.deepEqual(presentedSessionCookies(undefined), []);
  assert.deepEqual(presentedSessionCookies(null), []);
});

test('only the session cookies the request sent are cleared, with their attributes', () => {
  const cleared = presentedSessionCookies({ bsod_turnstile_verified: 'true', bsod_session_id: 'old', other: 'x' });
  assert.deepEqual(names(cleared), ['bsod_session_id', 'bsod_turnstile_verified']);
  assert.equal(cleared.find(c => c.name === 'bsod_session_id').httpOnly, true);
  assert.equal(cleared.find(c => c.name === 'bsod_turnstile_verified').httpOnly, false);
  // An empty value still counts as presented.
  assert.deepEqual(names(presentedSessionCookies({ bsod_session: '' })), ['bsod_session']);
});

test('the default set still covers every session cookie', () => {
  assert.deepEqual(names(ALL_SESSION_COOKIES), [
    'bsod_session', 'bsod_session_id', 'bsod_session_hash', 'bsod_turnstile_verified',
  ]);
});
