import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { transform } from 'rolldown/experimental';

// services/wfAuth.ts only has a type import, so a single-file transform loads it.
async function loadWfAuth() {
  const source = await fs.readFile(new URL('../services/wfAuth.ts', import.meta.url), 'utf8');
  const result = await transform('wfAuth.ts', source);
  if (result.errors?.length) throw new Error(`Failed to transform wfAuth.ts: ${result.errors[0]}`);
  return import(`data:text/javascript;base64,${Buffer.from(result.code, 'utf8').toString('base64')}`);
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
  };
}

// A fresh browser tab on bsod.windowsforum.com/analyzer.
function installWindow() {
  const location = { pathname: '/analyzer', search: '', hash: '', href: 'https://bsod.windowsforum.com/analyzer' };
  globalThis.window = {
    location,
    history: { replaceState: (_s, _t, url) => { location.hash = ''; location.href = `https://bsod.windowsforum.com${url}`; } },
    sessionStorage: memoryStorage(),
    localStorage: memoryStorage(),
  };
  return globalThis.window;
}

const wfAuth = await loadWfAuth();
const TOKEN = 'aGVhZGVy.cGF5bG9hZA.c2ln';

function startSignIn(win) {
  wfAuth.signInRedirect();
  const forumUrl = new URL(win.location.href);
  return { forumUrl, state: forumUrl.searchParams.get('state') };
}

test('a callback token this tab did not ask for is ignored (login CSRF, issue #137)', () => {
  const win = installWindow();
  win.location.hash = `#wf_sso=${TOKEN}`;
  assert.equal(wfAuth.consumeCallbackToken(), null);
  // The fragment is still stripped from the address bar.
  assert.equal(win.location.hash, '');
});

test('signInRedirect sends a fresh random state to the forum', () => {
  const win = installWindow();
  const first = startSignIn(win);
  assert.equal(first.forumUrl.origin + first.forumUrl.pathname, 'https://windowsforum.com/sso/whoami');
  assert.equal(first.forumUrl.searchParams.get('login'), '1');
  assert.equal(first.forumUrl.searchParams.get('redirect'), 'https://bsod.windowsforum.com/analyzer');
  assert.match(first.state, /^[a-f0-9]{32}$/);
  assert.notEqual(startSignIn(win).state, first.state);
});

test('the callback is accepted once when it echoes this tab\'s state', () => {
  const win = installWindow();
  const { state } = startSignIn(win);
  win.location.hash = `#wf_sso=${TOKEN}&wf_sso_state=${state}`;
  assert.deepEqual(wfAuth.consumeCallbackToken(), { token: TOKEN });
  // Replaying the same link in the tab no longer works: the state is single use.
  win.location.hash = `#wf_sso=${TOKEN}&wf_sso_state=${state}`;
  assert.equal(wfAuth.consumeCallbackToken(), null);
});

test('a wrong, missing or stale state is rejected', () => {
  const win = installWindow();
  startSignIn(win);
  win.location.hash = `#wf_sso=${TOKEN}&wf_sso_state=${'0'.repeat(32)}`;
  assert.equal(wfAuth.consumeCallbackToken(), null);

  startSignIn(win);
  win.location.hash = `#wf_sso=${TOKEN}`;
  assert.equal(wfAuth.consumeCallbackToken(), null);

  const { state } = startSignIn(win);
  const stored = JSON.parse(win.sessionStorage.getItem('wf_sso_sign_in_state'));
  win.sessionStorage.setItem('wf_sso_sign_in_state', JSON.stringify({ ...stored, at: Date.now() - 31 * 60 * 1000 }));
  win.location.hash = `#wf_sso=${TOKEN}&wf_sso_state=${state}`;
  assert.equal(wfAuth.consumeCallbackToken(), null);
});

test('the guest answer (#wf_sso_anon=1) is bound to the state too', () => {
  const win = installWindow();
  win.location.hash = '#wf_sso_anon=1';
  assert.equal(wfAuth.consumeCallbackToken(), null);

  const { state } = startSignIn(win);
  win.location.hash = `#wf_sso_anon=1&wf_sso_state=${state}`;
  assert.deepEqual(wfAuth.consumeCallbackToken(), { anon: true });
});
