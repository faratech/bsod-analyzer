import test, { after } from 'node:test';
import { createMountTracker, failFileAfter, JSDOM_FILE_TIMEOUT_MS } from './helpers/jsdomCleanup.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rolldown } from 'rolldown';
import { JSDOM } from 'jsdom';

// Mounts the real ThemeProvider (React bundled in, one instance) into jsdom
// with an in-memory localStorage.
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const HARNESS = `
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, useTheme } from ${JSON.stringify(path.join(root, 'hooks', 'useTheme.tsx'))};

let api;
function Probe() {
  api = useTheme();
  return null;
}

export async function mount(container) {
  const r = createRoot(container);
  await act(async () => {
    r.render(React.createElement(ThemeProvider, null, React.createElement(Probe)));
  });
  return { theme: () => api.theme, toggle: () => act(async () => { api.toggleTheme(); }), unmount: () => act(() => r.unmount()) };
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

function installDom(url, stored) {
  const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', { url });
  const map = new Map(Object.entries(stored));
  const storage = {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
  };
  Object.defineProperty(dom.window, 'localStorage', { configurable: true, value: storage });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent']) {
    Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : dom.window[key], configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return { dom, storage: map };
}

const harness = await loadHarness();

// Unmount every root even when an assertion fails, so the component's timers
// cannot keep this file alive (issue #321).
failFileAfter(JSDOM_FILE_TIMEOUT_MS, 'useTheme.test.mjs');
const track = createMountTracker();
const mountTracked = async (...args) => { const view = await harness.mount(...args); view.unmount = track(view.unmount); return view; };

test('an embed ?theme= override is applied but never written to the persisted theme (issue #238)', async () => {
  const { dom, storage } = installDom('https://bsod.windowsforum.com/stats/embed?theme=light', {
    theme: 'dark',
    'theme-manually-set': 'true',
  });
  const view = await mountTracked(dom.window.document.getElementById('root'));
  assert.equal(view.theme(), 'light', 'the URL override is applied');
  assert.ok(dom.window.document.documentElement.classList.contains('light'));
  assert.equal(storage.get('theme'), 'dark', 'the visitor\'s saved preference is untouched');
  assert.equal(storage.get('theme-manually-set'), 'true');
  await view.unmount();
  dom.window.close();
});

test('without an override the stored preference loads and an explicit toggle persists (issue #238)', async () => {
  const { dom, storage } = installDom('https://bsod.windowsforum.com/analyzer', {
    theme: 'light',
    'theme-manually-set': 'true',
  });
  const view = await mountTracked(dom.window.document.getElementById('root'));
  assert.equal(view.theme(), 'light');
  await view.toggle();
  assert.equal(view.theme(), 'dark');
  assert.equal(storage.get('theme'), 'dark');
  await view.unmount();
  dom.window.close();
});
