import test, { after, beforeEach } from 'node:test';
import { createMountTracker, failFileAfter, JSDOM_FILE_TIMEOUT_MS } from './helpers/jsdomCleanup.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rolldown } from 'rolldown';
import { JSDOM } from 'jsdom';

// Renders the real CloudflareTurnstile and FileUploader (React bundled in, one
// instance) into jsdom with a fake Turnstile API.
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const file = (...parts) => JSON.stringify(path.join(root, ...parts));
const HARNESS = `
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import CloudflareTurnstile from ${file('components', 'CloudflareTurnstile.tsx')};
import FileUploader from ${file('components', 'FileUploader.tsx')};

export async function mount(container, element) {
  const r = createRoot(container);
  await act(async () => { r.render(element); });
  return () => act(() => r.unmount());
}
export const turnstile = props => React.createElement(CloudflareTurnstile, props);
export const uploader = props => React.createElement(FileUploader, props);
export { act };
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

// Track the component's polling intervals and timeouts.
const liveIntervals = new Set();
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = (...args) => {
  const id = realSetInterval(...args);
  liveIntervals.add(id);
  return id;
};
globalThis.clearInterval = id => {
  liveIntervals.delete(id);
  realClearInterval(id);
};
after(() => {
  for (const id of liveIntervals) realClearInterval(id);
});

let dom;
function installDom() {
  dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>', { url: 'https://bsod.windowsforum.com/analyzer' });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent']) {
    Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : dom.window[key], configurable: true, writable: true });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}
beforeEach(() => {
  for (const id of liveIntervals) realClearInterval(id);
  liveIntervals.clear();
  installDom();
});

const harness = await loadHarness();

// Unmount every root even when an assertion fails, so the component's timers
// cannot keep this file alive (issue #321).
failFileAfter(JSDOM_FILE_TIMEOUT_MS, 'turnstileWidget.test.mjs');
const track = createMountTracker();
const mountTracked = async (...args) => track(await harness.mount(...args));
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
const script = () => dom.window.document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]');
const addStaleScript = () => {
  const tag = dom.window.document.createElement('script');
  tag.setAttribute('src', 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
  dom.window.document.head.appendChild(tag);
};

test('a Turnstile script that fails to load reports an error instead of spinning (issue #245)', async () => {
  let errors = 0;
  const container = dom.window.document.getElementById('root');
  const unmount = await mountTracked(container, harness.turnstile({ siteKey: 'k', onSuccess() {}, onError: () => { errors++; } }));
  assert.ok(script(), 'the script is injected');
  assert.match(container.textContent, /Loading security check/);

  await harness.act(async () => { script().dispatchEvent(new dom.window.Event('error')); });
  assert.equal(errors, 1);
  assert.doesNotMatch(container.textContent, /Loading security check/);
  assert.equal(script(), null, 'the failed tag is dropped so a later mount loads it again');
  assert.equal(liveIntervals.size, 0);
  await unmount();
});

test('a Turnstile API that never appears times out into the error path (issue #245)', async () => {
  addStaleScript(); // tag present, window.turnstile never defined
  let errors = 0;
  const container = dom.window.document.getElementById('root');
  const unmount = await mountTracked(container, harness.turnstile({ siteKey: 'k', onSuccess() {}, onError: () => { errors++; }, loadTimeoutMs: 50 }));
  await harness.act(async () => { await tick(120); });
  assert.equal(errors, 1);
  assert.doesNotMatch(container.textContent, /Loading security check/);
  assert.equal(liveIntervals.size, 0, 'polling stops after the timeout');
  await unmount();
});

test('unmounting while waiting for Turnstile clears the readiness poll (issues #218, #245)', async () => {
  addStaleScript();
  let errors = 0;
  const container = dom.window.document.getElementById('root');
  const unmount = await mountTracked(container, harness.turnstile({ siteKey: 'k', onSuccess() {}, onError: () => { errors++; }, loadTimeoutMs: 50 }));
  assert.equal(liveIntervals.size, 1, 'polling for window.turnstile');
  await unmount();
  assert.equal(liveIntervals.size, 0, 'no interval survives unmount');
  await tick(100);
  assert.equal(errors, 0, 'no timeout fires after unmount');
});

// Faithful fake: with the default `execution: 'render'` the real widget runs
// the challenge on render and again on every reset(), and a non-interactive
// challenge then calls the success callback with a fresh token by itself.
const fakeWidgets = [];
function fakeTurnstile(solveMs = 10) {
  const w = { callback: null, renders: 0, resets: 0, n: 0, timers: [] };
  const solve = () => { w.timers.push(setTimeout(() => w.callback?.(`tok-${++w.n}`), solveMs)); };
  dom.window.turnstile = {
    render: (_el, options) => { w.renders++; w.callback = options.callback; solve(); return 'w1'; },
    reset: () => { w.resets++; solve(); },
    remove: () => { w.callback = null; },
  };
  fakeWidgets.push(w);
  return w;
}
after(() => { for (const w of fakeWidgets) w.timers.forEach(clearTimeout); });

const verifyPosts = requests => requests.filter(url => url === '/api/auth/verify-turnstile').length;
const retryButton = container => [...container.querySelectorAll('button')].find(b => b.textContent === 'Retry security check');

async function mountUploader(respond) {
  const widget = fakeTurnstile();
  addStaleScript();
  const requests = [];
  globalThis.fetch = async url => {
    requests.push(url);
    if (url !== '/api/auth/verify-turnstile') {
      return { ok: true, status: 200, json: async () => ({ valid: true, success: true }) };
    }
    return respond(verifyPosts(requests));
  };
  const container = dom.window.document.getElementById('root');
  const unmountRoot = await mountTracked(container, harness.uploader({ onFilesAdded() {} }));
  const unmount = track(async () => { widget.timers.forEach(clearTimeout); await unmountRoot(); });
  return { widget, requests, container, unmount };
}

const reject = (status, body) => ({ ok: false, status, json: async () => ({ success: false, ...body }) });

test('a successful verification clears an earlier failure message (issue #277)', async () => {
  const { widget, requests, container, unmount } = await mountUploader(n => (
    n === 1
      ? reject(400, { error: 'Security token already used or expired', 'error-codes': ['timeout-or-duplicate'] })
      : { ok: true, status: 200, json: async () => ({ success: true }) }
  ));
  await harness.act(async () => { await tick(400); });
  assert.equal(verifyPosts(requests), 2);
  assert.equal(widget.resets, 1);
  assert.match(container.textContent, /Security check completed/);
  assert.doesNotMatch(container.textContent, /already used or expired/);
  await unmount();
});

for (const [label, respond] of [
  ['a 429 from the rate limiter', () => reject(429, { error: 'Too many requests' })],
  ['a 500', () => reject(500, { error: 'Internal server error' })],
  ['a bad server secret', () => reject(400, { error: 'Server configuration error', 'error-codes': ['invalid-input-secret'] })],
  ['an action mismatch', () => reject(400, { error: 'Security verification action mismatch', code: 'TURNSTILE_ACTION_MISMATCH' })],
  ['a network error', () => { throw new TypeError('network down'); }],
]) {
  test(`${label} is not retried automatically; Retry starts one new attempt (issue #277)`, async () => {
    const { widget, requests, container, unmount } = await mountUploader(respond);
    await harness.act(async () => { await tick(400); });
    assert.equal(verifyPosts(requests), 1, 'one POST, no reset/re-solve loop');
    assert.equal(widget.resets, 0);
    assert.match(container.textContent, /Security Check Required/);
    const retry = retryButton(container);
    assert.ok(retry, 'a visible retry is offered');

    await harness.act(async () => { retry.click(); await tick(400); });
    assert.equal(widget.renders, 2, 'retry renders a fresh widget');
    assert.equal(verifyPosts(requests), 2, 'retry costs exactly one more POST');
    assert.equal(widget.resets, 0);
    await unmount();
  });
}

test('a spent or invalid token is reset at most once per attempt (issues #245, #277)', async () => {
  for (const code of ['timeout-or-duplicate', 'invalid-input-response']) {
    installDom();
    const { widget, requests, container, unmount } = await mountUploader(
      () => reject(400, { error: 'Security token already used or expired', 'error-codes': [code] })
    );
    await harness.act(async () => { await tick(400); });
    assert.equal(widget.resets, 1, `${code}: the spent token is replaced once`);
    assert.equal(verifyPosts(requests), 2, `${code}: bounded POSTs`);
    assert.ok(retryButton(container), 'then the visitor decides');

    await harness.act(async () => { retryButton(container).click(); await tick(400); });
    assert.equal(verifyPosts(requests), 4, 'a new attempt gets its own single reset');
    assert.equal(widget.resets, 2);
    await unmount();
  }
});
