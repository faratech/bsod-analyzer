import test from 'node:test';
import assert from 'node:assert/strict';
import { rolldown } from 'rolldown';

// services/wfAuth.ts imports utils/sessionManager.ts (a successful exchange
// marks a new session, issue #341), so bundle it with its imports.
async function loadWfAuth() {
  const bundle = await rolldown({ input: new URL('../services/wfAuth.ts', import.meta.url).pathname, logLevel: 'silent' });
  const { output } = await bundle.generate({ format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(output[0].code, 'utf8').toString('base64')}`);
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

// Issue #354: the server keeps the session id when an exchange re-verifies
// this session's own user, and says so; only a new id bumps the generation
// that guards kept WinDBG results (#341).
test('an exchange that kept the session id does not bump the session generation; any other does (#354)', async t => {
  const root = new URL('..', import.meta.url).pathname;
  const bundle = await rolldown({
    input: 'entry',
    logLevel: 'silent',
    plugins: [{
      name: 'entry',
      resolveId: id => (id === 'entry' ? id : null),
      load: id => (id === 'entry'
        ? `export { exchangeToken } from '${root}services/wfAuth.ts'; export { getSessionGeneration } from '${root}utils/sessionManager.ts';`
        : null)
    }]
  });
  const { output } = await bundle.generate({ format: 'esm' });
  const { exchangeToken, getSessionGeneration } = await import(`data:text/javascript;base64,${Buffer.from(output[0].code, 'utf8').toString('base64')}`);
  installWindow();
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  let answer;
  globalThis.fetch = async () => new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const user = { userId: 42, username: 'user42', avatar: '', tier: 'premium', isPremium: true };

  const start = getSessionGeneration();
  answer = { success: true, sessionKept: true, tier: 'premium', user };
  assert.deepEqual(await exchangeToken(TOKEN), user);
  assert.equal(getSessionGeneration(), start, 'same session id: kept results stay usable');

  answer = { success: true, sessionKept: false, tier: 'premium', user };
  await exchangeToken(TOKEN);
  assert.equal(getSessionGeneration(), start + 1);

  answer = { success: true, tier: 'premium', user }; // an older server: always a new id
  await exchangeToken(TOKEN);
  assert.equal(getSessionGeneration(), start + 2);
});
