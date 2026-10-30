import test, { after, beforeEach } from 'node:test';
import { createMountTracker, failFileAfter, JSDOM_FILE_TIMEOUT_MS } from './helpers/jsdomCleanup.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rolldown } from 'rolldown';
import { JSDOM, VirtualConsole } from 'jsdom';

// Renders the real ChunkErrorBoundary (React bundled in, one instance) into
// jsdom around a React.lazy route whose import rejects the way each browser
// (and Vite's CSS preload helper) rejects after a deploy removed the chunk.
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const file = (...parts) => JSON.stringify(path.join(root, ...parts));
const HARNESS = `
import React, { act, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import ChunkErrorBoundary from ${file('components', 'ChunkErrorBoundary.tsx')};
import { lazyRoute } from ${file('utils', 'chunkReload.ts')};
export { installChunkPreloadRecovery, CHUNK_RELOAD_KEY, CHUNK_RELOAD_COUNT_KEY } from ${file('utils', 'chunkReload.ts')};

// NAV sits outside the boundary, as the header and footer do in AppRouter.
export async function mountRejectingRoute(container, error, wrap = false) {
  const load = () => Promise.reject(error);
  const Lazy = wrap ? lazyRoute(load) : React.lazy(load);
  const uncaught = [];
  const r = createRoot(container, { onUncaughtError: e => uncaught.push(e) });
  await act(async () => {
    r.render(React.createElement('div', null,
      React.createElement('span', null, 'NAV'),
      React.createElement(ChunkErrorBoundary, null,
        React.createElement(Suspense, { fallback: 'loading' }, React.createElement(Lazy)))));
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  return { uncaught, unmount: () => act(() => r.unmount()) };
}

// A lazyRoute whose import resolves (render + commit) or never settles.
export async function mountLazyRoute(container, settle) {
  const Page = () => React.createElement('p', null, 'PAGE');
  const load = settle === 'never' ? () => new Promise(() => {}) : () => Promise.resolve({ default: Page });
  const Lazy = lazyRoute(load);
  const r = createRoot(container);
  await act(async () => {
    r.render(React.createElement(ChunkErrorBoundary, null,
      React.createElement(Suspense, { fallback: 'loading' }, React.createElement(Lazy))));
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  return { unmount: () => act(() => r.unmount()) };
}

export async function mountThrowingChild(container, error) {
  const Boom = () => { throw error; };
  const uncaught = [];
  const r = createRoot(container, { onUncaughtError: e => uncaught.push(e) });
  await act(async () => {
    r.render(React.createElement('div', null,
      React.createElement('span', null, 'NAV'),
      React.createElement(ChunkErrorBoundary, null, React.createElement(Boom))));
  });
  return { uncaught, unmount: () => act(() => r.unmount()) };
}
`;

async function loadHarness() {
  const bundle = await rolldown({
    input: 'harness',
    platform: 'browser',
    logLevel: 'silent',
    transform: { define: { 'process.env.NODE_ENV': '"development"' } },
    plugins: [{
      name: 'harness',
      resolveId: id => (id === 'harness' ? id : null),
      load: id => (id === 'harness' ? HARNESS : null),
    }],
  });
  const { output } = await bundle.generate({ format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(output[0].code, 'utf8').toString('base64')}`);
}

// Bundled React can't reach Node's timers module, so act() queues work through
// MessageChannels whose ports would keep the test process alive.
const channels = [];
const NodeMessageChannel = globalThis.MessageChannel;
globalThis.MessageChannel = class extends NodeMessageChannel {
  constructor() {
    super();
    channels.push(this);
  }
};
after(() => {
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
});

let dom;
let reloads = 0;
function installDom() {
  // jsdom does not implement location.reload(); it reports each call as a
  // "navigation" jsdomError, which is how reload attempts are counted here.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => { if (/navigation/i.test(e.message)) reloads++; });
  dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'https://bsod.windowsforum.com/about',
    virtualConsole,
  });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'sessionStorage']) {
    Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : dom.window[key], configurable: true, writable: true });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}
beforeEach(() => {
  reloads = 0;
  installDom();
});

// React logs caught render errors; keep the test output readable.
const realConsoleError = console.error;
console.error = () => {};
after(() => { console.error = realConsoleError; });

const harness = await loadHarness();

// Unmount every root even when an assertion fails, so the component's timers
// cannot keep this file alive (issue #321).
failFileAfter(JSDOM_FILE_TIMEOUT_MS, 'chunkErrorBoundary.test.mjs');
const track = createMountTracker();
const mountRejectingRoute = async (...args) => { const view = await harness.mountRejectingRoute(...args); view.unmount = track(view.unmount); return view; };
const mountThrowingChild = async (...args) => { const view = await harness.mountThrowingChild(...args); view.unmount = track(view.unmount); return view; };
const mountLazyRoute = async (...args) => { const view = await harness.mountLazyRoute(...args); view.unmount = track(view.unmount); return view; };

const CHUNK_MESSAGES = {
  Chrome: 'Failed to fetch dynamically imported module: https://bsod.windowsforum.com/assets/About-abc.js',
  Firefox: 'error loading dynamically imported module: https://bsod.windowsforum.com/assets/About-abc.js',
  Safari: 'Importing a module script failed.',
  'Vite CSS preload': 'Unable to preload CSS for /assets/About-abc.css',
};

for (const [source, message] of Object.entries(CHUNK_MESSAGES)) {
  test(`a lazy route rejected with the ${source} message shows the update fallback and reloads once (issue #294)`, async () => {
    const container = dom.window.document.getElementById('root');
    const { uncaught, unmount } = await mountRejectingRoute(container, new TypeError(message));
    assert.deepEqual(uncaught.map(e => e.message), [], 'the error stays inside the boundary');
    assert.match(container.textContent, /NAV/, 'the rest of the page stays mounted');
    assert.match(container.textContent, /A new version is available/);
    assert.equal(reloads, 1, 'one automatic reload');
    const stamp = Number(dom.window.sessionStorage.getItem(harness.CHUNK_RELOAD_KEY));
    assert.ok(stamp > Date.now() - 5000 && stamp <= Date.now(), 'the guard stores when the reload happened');
    await unmount();
  });
}

test('any rejection of a lazyRoute import counts as a chunk error, whatever the message (issue #294)', async () => {
  const container = dom.window.document.getElementById('root');
  const { uncaught, unmount } = await mountRejectingRoute(container, new TypeError('NetworkError when attempting to fetch resource.'), true);
  assert.deepEqual(uncaught.map(e => e.message), []);
  assert.match(container.textContent, /A new version is available/);
  assert.equal(reloads, 1);
  await unmount();
});

test('every lazy route in AppRouter goes through lazyRoute (issue #294)', () => {
  const router = fs.readFileSync(path.join(root, 'AppRouter.tsx'), 'utf8');
  assert.doesNotMatch(router, /React\.lazy\(/);
  assert.match(router, /lazyRoute\(\(\) => import\('\.\/pages\/Analyzer'\)\)/);
});

test('a reload in the last few seconds is not repeated, so a broken deploy cannot loop (issue #294)', async () => {
  dom.window.sessionStorage.setItem(harness.CHUNK_RELOAD_KEY, String(Date.now() - 1000));
  const container = dom.window.document.getElementById('root');
  const { unmount } = await mountRejectingRoute(container, new TypeError(CHUNK_MESSAGES.Firefox));
  assert.match(container.textContent, /A new version is available/);
  assert.equal(reloads, 0);
  await unmount();
});

test('an old reload guard (an earlier deploy in the same tab) still allows a reload (issue #294)', async () => {
  for (const stale of ['1', String(Date.now() - 60_000)]) {
    reloads = 0;
    dom.window.sessionStorage.setItem(harness.CHUNK_RELOAD_KEY, stale);
    const container = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(container);
    const { unmount } = await mountRejectingRoute(container, new TypeError(CHUNK_MESSAGES.Chrome));
    assert.equal(reloads, 1, `guard value ${stale} does not block the reload`);
    await unmount();
  }
});

// One page load of a tab whose route chunk keeps failing, `atMs` after the
// first: each load mounts the boundary again with the same sessionStorage.
async function loadFailingPageAt(atMs, start) {
  const realNow = Date.now;
  Date.now = () => start + atMs;
  try {
    const container = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(container);
    const { unmount } = await mountRejectingRoute(container, new TypeError(CHUNK_MESSAGES.Chrome));
    const text = container.textContent;
    await unmount();
    return text;
  } finally {
    Date.now = realNow;
  }
}

test('a persistently failing chunk on a slow load reloads at most twice, then shows the fallback (issue #308)', async () => {
  const start = Date.now();
  // Each reload cycle (HTML + entry JS + lazy import) takes 11 s: longer than
  // the 10 s timestamp window, so only the reload budget can end the loop.
  for (let i = 0; i < 8; i++) {
    const text = await loadFailingPageAt(i * 11_000, start);
    assert.match(text, /A new version is available/);
  }
  assert.equal(reloads, 2, 'two automatic reloads, then the fallback stays');

  // The budget is per 5 minutes: a later deploy in the same tab reloads again.
  await loadFailingPageAt(5 * 60_000 + 30_000, start);
  assert.equal(reloads, 3);
});

test('the reload guard survives a slow lazy route that is still loading (issue #308)', async () => {
  dom.window.sessionStorage.setItem(harness.CHUNK_RELOAD_KEY, String(Date.now() - 1000));
  dom.window.sessionStorage.setItem(harness.CHUNK_RELOAD_COUNT_KEY, `${Date.now() - 1000}:1`);
  // Fire every timer the boundary arms, however long, while the route is suspended.
  const realSetTimeout = globalThis.setTimeout;
  const pending = [];
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms >= 1000) { pending.push(fn); return 0; }
    return realSetTimeout(fn, ms, ...args);
  };
  try {
    const container = dom.window.document.getElementById('root');
    const { unmount } = await mountLazyRoute(container, 'never');
    for (const fn of pending.splice(0)) fn();
    assert.match(container.textContent, /loading/);
    assert.notEqual(dom.window.sessionStorage.getItem(harness.CHUNK_RELOAD_KEY), null, 'the guard is kept while the route is suspended');
    assert.notEqual(dom.window.sessionStorage.getItem(harness.CHUNK_RELOAD_COUNT_KEY), null);
    await unmount();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('the reload guard is cleared once a lazy route commits (issue #308)', async () => {
  dom.window.sessionStorage.setItem(harness.CHUNK_RELOAD_KEY, String(Date.now() - 1000));
  dom.window.sessionStorage.setItem(harness.CHUNK_RELOAD_COUNT_KEY, `${Date.now() - 1000}:1`);
  const container = dom.window.document.getElementById('root');
  const { unmount } = await mountLazyRoute(container, 'resolve');
  assert.match(container.textContent, /PAGE/);
  assert.equal(dom.window.sessionStorage.getItem(harness.CHUNK_RELOAD_KEY), null);
  assert.equal(dom.window.sessionStorage.getItem(harness.CHUNK_RELOAD_COUNT_KEY), null);
  await unmount();
});

test('a non-chunk render error shows a fallback instead of unmounting the page, without reloading (issue #294)', async () => {
  const container = dom.window.document.getElementById('root');
  const { uncaught, unmount } = await mountThrowingChild(container, new Error('Cannot read properties of undefined'));
  assert.deepEqual(uncaught.map(e => e.message), []);
  assert.match(container.textContent, /NAV/);
  assert.match(container.textContent, /Something went wrong/);
  assert.ok(container.querySelector('button'), 'a refresh button is offered');
  assert.equal(reloads, 0);
  assert.equal(dom.window.sessionStorage.getItem(harness.CHUNK_RELOAD_KEY), null);
  await unmount();
});

test('vite:preloadError is suppressed and triggers the guarded reload (issue #294)', async () => {
  const dispose = harness.installChunkPreloadRecovery(dom.window);
  const event = new dom.window.Event('vite:preloadError', { cancelable: true });
  dom.window.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true, 'Vite does not rethrow the preload error');
  assert.equal(reloads, 1);
  const again = new dom.window.Event('vite:preloadError', { cancelable: true });
  dom.window.dispatchEvent(again);
  assert.equal(reloads, 1, 'a second failure right after the reload does not loop');
  dispose();
});

test('vite:preloadError is left to Vite when the reload is refused, so the chunk error reaches the boundary (issue #309)', () => {
  const dispose = harness.installChunkPreloadRecovery(dom.window);
  // Guard still active: no reload, so Vite must rethrow (lazyRoute then
  // reports a ChunkLoadError) instead of resolving the import to undefined.
  dom.window.sessionStorage.setItem(harness.CHUNK_RELOAD_KEY, String(Date.now() - 1000));
  const refused = new dom.window.Event('vite:preloadError', { cancelable: true });
  dom.window.dispatchEvent(refused);
  assert.equal(reloads, 0);
  assert.equal(refused.defaultPrevented, false, 'a refused reload does not swallow the error');

  // Storage unavailable: no loop guard, no reload, no suppression.
  const getter = Object.getOwnPropertyDescriptor(dom.window, 'sessionStorage');
  Object.defineProperty(dom.window, 'sessionStorage', { configurable: true, get() { throw new dom.window.DOMException('blocked', 'SecurityError'); } });
  try {
    const blocked = new dom.window.Event('vite:preloadError', { cancelable: true });
    dom.window.dispatchEvent(blocked);
    assert.equal(reloads, 0);
    assert.equal(blocked.defaultPrevented, false);
  } finally {
    if (getter) Object.defineProperty(dom.window, 'sessionStorage', getter);
    else delete dom.window.sessionStorage;
  }
  dispose();
});

test('the client entry installs the vite:preloadError recovery (issue #294)', () => {
  const entry = fs.readFileSync(path.join(root, 'index.tsx'), 'utf8');
  assert.match(entry, /installChunkPreloadRecovery\(window\)/);
});
