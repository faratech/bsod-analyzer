import test, { after } from 'node:test';
import { createMountTracker, failFileAfter, JSDOM_FILE_TIMEOUT_MS } from './helpers/jsdomCleanup.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rolldown } from 'rolldown';
import { JSDOM } from 'jsdom';

// Retry on a failed analysis is gated on the data-use checkbox like Analyze
// (#236): unchecked, the button is disabled and never fires onRetry.
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const file = (...parts) => JSON.stringify(path.join(root, ...parts));
const HARNESS = `
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import AnalysisResults from ${file('components', 'AnalysisResults.tsx')};
import { FileStatus } from ${file('types.ts')};

export async function mountResults(container, props) {
  const r = createRoot(container);
  await act(async () => {
    r.render(React.createElement(MemoryRouter, null, React.createElement(AnalysisResults, props)));
  });
  return () => act(() => r.unmount());
}
export { act, FileStatus };
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

function installDom() {
  const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', { url: 'https://bsod.windowsforum.com/analyzer' });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent']) {
    Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : dom.window[key], configurable: true, writable: true });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
  return dom;
}

const harness = await loadHarness();

// Unmount every root even when an assertion fails, so the component's timers
// cannot keep this file alive (issue #321).
failFileAfter(JSDOM_FILE_TIMEOUT_MS, 'retryConsent.test.mjs');
const track = createMountTracker();
const mountResults = async (...args) => track(await harness.mountResults(...args));

const failedFile = () => ({
  id: 'f1',
  file: { name: 'crash.dmp' },
  status: harness.FileStatus.ERROR,
  error: 'Upload failed'
});

function retryButton(container) {
  return [...container.querySelectorAll('button')].find(b => b.textContent.includes('Retry Analysis'));
}

test('Retry is disabled and inert while the data-use box is unchecked (#236)', async () => {
  const dom = installDom();
  const container = dom.window.document.getElementById('root');
  const retried = [];
  const unmount = await mountResults(container, {
    dumpFiles: [failedFile()],
    onRetry: id => retried.push(id),
    retryDisabled: true
  });
  const button = retryButton(container);
  assert.ok(button, 'Retry button rendered');
  assert.equal(button.disabled, true);
  assert.match(button.getAttribute('title') || '', /Use my crash analysis to improve BSOD AI/);
  await harness.act(async () => { button.click(); });
  assert.deepEqual(retried, []);
  await unmount();
  dom.window.close();
});

test('Retry stays enabled and fires when the data-use box is checked', async () => {
  const dom = installDom();
  const container = dom.window.document.getElementById('root');
  const retried = [];
  const unmount = await mountResults(container, {
    dumpFiles: [failedFile()],
    onRetry: id => retried.push(id),
    retryDisabled: false
  });
  const button = retryButton(container);
  assert.equal(button.disabled, false);
  await harness.act(async () => { button.click(); });
  assert.deepEqual(retried, ['f1']);
  await unmount();
  dom.window.close();
});
