import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rolldown } from 'rolldown';
import { JSDOM } from 'jsdom';

import { DATA_USE_TERMS_VERSION } from '../shared/dataUseTerms.js';

// Renders the real DataUseAgreement (with React and the router bundled in, so
// there is a single React instance) into jsdom, inside a parent that owns the
// checkbox state the way pages/Analyzer.tsx does.
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const HARNESS = `
import React, { useState } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import DataUseAgreement from ${JSON.stringify(path.join(root, 'components', 'DataUseAgreement.tsx'))};
import { isDataUseAccepted } from ${JSON.stringify(path.join(root, 'utils', 'dataUse.ts'))};

function Page() {
  const [accepted, setAccepted] = useState(true);
  return React.createElement(MemoryRouter, null,
    React.createElement(DataUseAgreement, { accepted, onChange: setAccepted }));
}

export async function mount(container) {
  const r = createRoot(container);
  await act(async () => { r.render(React.createElement(Page)); });
  return { unmount: () => act(() => r.unmount()) };
}
export { act, isDataUseAccepted };
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

function installDom(stored) {
  const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', { url: 'https://bsod.windowsforum.com/analyzer' });
  const map = new Map(Object.entries(stored));
  Object.defineProperty(dom.window, 'localStorage', {
    configurable: true,
    value: {
      getItem: key => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => { map.set(key, String(value)); },
      removeItem: key => { map.delete(key); },
    },
  });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent']) {
    Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : dom.window[key], configurable: true, writable: true });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return { dom, storage: map };
}

// Bundled React can't reach Node's timers module, so act() queues work through
// MessageChannels whose ports would keep the test process alive. Track and
// close them once the tests are done.
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

const harness = await loadHarness();
const VERSION_KEY = 'bsod.dataUse.acceptedVersion';

test('terms changed since this browser agreed: the box starts unchecked with a notice (issue #144)', async () => {
  const { dom, storage } = installDom({ [VERSION_KEY]: '2020-01-01' });
  const container = dom.window.document.getElementById('root');
  const view = await harness.mount(container);
  const box = container.querySelector('input[type="checkbox"]');
  assert.equal(box.checked, false);
  assert.equal(harness.isDataUseAccepted(), false);
  assert.match(container.textContent, /terms changed since you last agreed/);

  // Checking it again is the new agreement: the notice goes and the version is recorded.
  await harness.act(async () => { box.click(); });
  assert.equal(box.checked, true);
  assert.equal(harness.isDataUseAccepted(), true);
  assert.equal(storage.get(VERSION_KEY), DATA_USE_TERMS_VERSION);
  assert.doesNotMatch(container.textContent, /terms changed/);
  await view.unmount();
  dom.window.close();
});

test('the current version, or no stored version, keeps the default-checked box', async () => {
  for (const stored of [{ [VERSION_KEY]: DATA_USE_TERMS_VERSION }, {}]) {
    const { dom } = installDom(stored);
    const container = dom.window.document.getElementById('root');
    const view = await harness.mount(container);
    assert.equal(container.querySelector('input[type="checkbox"]').checked, true, JSON.stringify(stored));
    assert.doesNotMatch(container.textContent, /terms changed/);
    await view.unmount();
    dom.window.close();
  }
});
