import test, { after } from 'node:test';
import { createMountTracker, failFileAfter, JSDOM_FILE_TIMEOUT_MS } from './helpers/jsdomCleanup.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rolldown } from 'rolldown';
import { JSDOM } from 'jsdom';

// Renders the real AnalysisProgress, AnalysisCompletionAnnouncer and
// FileUploader (React bundled in, one instance) into jsdom.
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const file = (...parts) => JSON.stringify(path.join(root, ...parts));
const HARNESS = `
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import AnalysisProgress from ${file('components', 'AnalysisProgress.tsx')};
import AnalysisCompletionAnnouncer from ${file('components', 'AnalysisCompletionAnnouncer.tsx')};
import FileUploader from ${file('components', 'FileUploader.tsx')};
import { stopSessionRefresh } from ${file('utils', 'sessionManager.ts')};

export function mount(container, element) {
  const r = createRoot(container);
  return {
    async render(el) { await act(async () => { r.render(el); }); },
    async unmount() { await act(async () => { r.unmount(); }); },
  };
}
export { React, act, stopSessionRefresh, AnalysisProgress, AnalysisCompletionAnnouncer, FileUploader };
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
  h.stopSessionRefresh('uploader');
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
});

function installDom() {
  const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', { url: 'https://bsod.windowsforum.com/analyzer' });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'File']) {
    Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : dom.window[key], configurable: true, writable: true });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: true }) });
  return dom;
}

const h = await loadHarness();

// Unmount every root even when an assertion fails, so the component's timers
// cannot keep this file alive (issue #321).
failFileAfter(JSDOM_FILE_TIMEOUT_MS, 'analyzerA11y.test.mjs');
const track = createMountTracker();
const mountTracked = (...args) => { const view = h.mount(...args); view.unmount = track(view.unmount.bind(view)); return view; };
const { React } = h;

test('the progress card carries a polite status region with only the stage title and message (issue #297)', async () => {
  const dom = installDom();
  const container = dom.window.document.getElementById('root');
  const view = mountTracked(container);
  await view.render(React.createElement(h.AnalysisProgress, { stage: 'processing', message: 'Queued behind 2 jobs', startTime: Date.now() - 5000 }));

  const region = container.querySelector('[role="status"]');
  assert.ok(region, 'a role=status region exists');
  assert.equal(region.getAttribute('aria-live'), 'polite');
  assert.equal(region.getAttribute('aria-atomic'), 'true');
  assert.match(region.className, /sr-only/, 'visually hidden');
  assert.equal(region.textContent, 'WinDBG Analysis in Progress. Queued behind 2 jobs');
  assert.doesNotMatch(region.textContent, /Elapsed|\d+s/, 'the timer is not announced');
  assert.equal(container.querySelectorAll('[aria-live]').length, 1, 'only one live region on the card');

  const title = container.querySelector('.progress-title');
  assert.ok(title.querySelector('[aria-hidden="true"]'), 'the animated dots are hidden from assistive technology');
  await view.unmount();
  dom.window.close();
});

test('the announcer says how many files finished when a run ends (issue #297)', async () => {
  const dom = installDom();
  const container = dom.window.document.getElementById('root');
  const view = mountTracked(container);
  const el = (isAnalyzing, analyzedCount) => React.createElement(h.AnalysisCompletionAnnouncer, { isAnalyzing, analyzedCount });

  await view.render(el(false, 0));
  const region = () => container.querySelector('[role="status"]');
  assert.ok(region(), 'the region is persistent, present before any run');
  assert.equal(region().getAttribute('aria-live'), 'polite');
  assert.equal(region().textContent, '');

  await view.render(el(true, 0));
  assert.equal(region().textContent, '', 'nothing is announced while the run is in progress');
  await view.render(el(true, 2));
  await view.render(el(false, 2));
  assert.equal(region().textContent, 'Analysis complete for 2 files');

  await view.render(el(true, 2));
  assert.equal(region().textContent, '', 'cleared when the next run starts');
  await view.render(el(false, 3));
  assert.equal(region().textContent, 'Analysis complete for 1 file');
  await view.unmount();
  dom.window.close();
});

async function mountVerifiedUploader(dom) {
  dom.window.document.cookie = 'bsod_turnstile_verified=true; path=/';
  const container = dom.window.document.getElementById('root');
  const view = mountTracked(container);
  await view.render(React.createElement(h.FileUploader, { onFilesAdded: () => {}, currentFileCount: 0 }));
  return { container, view };
}

test('upload validation errors are an alert outside the label, linked to the input (issue #297)', async () => {
  const dom = installDom();
  const { container, view } = await mountVerifiedUploader(dom);
  const input = container.querySelector('input#file-upload');
  assert.ok(input, 'verified uploader shows the file input');
  assert.equal(input.getAttribute('aria-describedby'), null);

  const bad = new dom.window.File(['hello world, not a dump'], 'notes.txt', { type: 'text/plain' });
  Object.defineProperty(input, 'files', { value: [bad], configurable: true });
  await h.act(async () => { input.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
  await h.act(async () => { await new Promise(r => setTimeout(r, 50)); });

  const alert = container.querySelector('[role="alert"]');
  assert.ok(alert, 'errors render in a role=alert container');
  assert.ok(alert.textContent.length > 0);
  assert.equal(alert.closest('label'), null, 'errors are not part of the input label');
  assert.ok(alert.id, 'the alert has an id');
  assert.equal(input.getAttribute('aria-describedby'), alert.id);
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(container.querySelector('label').textContent.includes(alert.textContent), false);
  await view.unmount();
  dom.window.close();
});

test('the success line uses a defined colour token (issue #301)', async () => {
  const dom = installDom();
  const { container, view } = await mountVerifiedUploader(dom);
  assert.doesNotMatch(container.innerHTML, /--text-success/);
  assert.match(container.innerHTML, /var\(--status-success\)/);
  await view.unmount();
  dom.window.close();
});

test('the Turnstile-pending branch also announces errors as an alert (issue #297)', async () => {
  const dom = installDom();
  const container = dom.window.document.getElementById('root');
  const view = mountTracked(container);
  await view.render(React.createElement(h.FileUploader, { onFilesAdded: () => {}, currentFileCount: 0 }));
  assert.equal(container.querySelector('input#file-upload'), null, 'not verified: no input yet');
  await h.act(async () => { dom.window.dispatchEvent(new dom.window.CustomEvent('bsod-session-invalid')); });
  const alert = container.querySelector('[role="alert"]');
  assert.ok(alert);
  assert.match(alert.textContent, /security check/i);
  await view.unmount();
  dom.window.close();
});
