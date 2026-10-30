import test, { after } from 'node:test';
import { createMountTracker, failFileAfter, JSDOM_FILE_TIMEOUT_MS } from './helpers/jsdomCleanup.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rolldown } from 'rolldown';
import { JSDOM } from 'jsdom';

// Mounts the real AnalysisProgress (React bundled in, one instance) into jsdom
// with a controllable clock and manually driven intervals.
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const HARNESS = `
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import AnalysisProgress from ${JSON.stringify(path.join(root, 'components', 'AnalysisProgress.tsx'))};

export async function mount(container, props) {
  const r = createRoot(container);
  const render = p => act(async () => { r.render(React.createElement(AnalysisProgress, p)); });
  await render(props);
  return { render, unmount: () => act(() => r.unmount()) };
}
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

const channels = [];
const NodeMessageChannel = globalThis.MessageChannel;
globalThis.MessageChannel = class extends NodeMessageChannel {
  constructor() {
    super();
    channels.push(this);
  }
};

// Controllable clock and intervals (the component reads Date.now and ticks via
// setInterval; React itself schedules through MessageChannel, not these).
let now = 1_000_000_000_000;
const realNow = Date.now;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const intervals = new Map();
let nextId = 1;
Date.now = () => now;
globalThis.setInterval = (fn, ms) => { const id = nextId++; intervals.set(id, { fn, ms }); return id; };
globalThis.clearInterval = id => { intervals.delete(id); };

after(() => {
  Date.now = realNow;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
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
  return dom;
}

const harness = await loadHarness();

// Unmount every root even when an assertion fails, so the component's timers
// cannot keep this file alive (issue #321).
failFileAfter(JSDOM_FILE_TIMEOUT_MS, 'analysisProgress.test.mjs');
const track = createMountTracker();
const mountTracked = async (...args) => { const view = await harness.mount(...args); view.unmount = track(view.unmount); return view; };

async function advance(seconds) {
  now += seconds * 1000;
  await harness.act(async () => {
    for (const { fn, ms } of [...intervals.values()]) if (ms === 1000) fn();
  });
}

test('"Taking longer than usual" measures time in the current stage, not the whole run (issue #246)', async () => {
  const dom = installDom();
  const container = dom.window.document.getElementById('root');
  const startTime = now;
  const view = await mountTracked(container, { stage: 'processing', startTime });

  // 80 s of WinDBG processing (90 s budget): normal.
  await advance(80);
  assert.doesNotMatch(container.textContent, /Taking longer than usual/);

  // AI stage (30 s budget) starts with 80 s already on the run clock.
  await view.render({ stage: 'analyzing', startTime });
  await advance(1);
  const time = container.querySelector('.progress-time').textContent;
  assert.match(time, /Elapsed: 1m 21s/, 'the displayed clock stays the total run time');
  assert.doesNotMatch(time, /Taking longer than usual/, 'a stage that just started is not flagged');
  assert.match(time, /usually 10.30 seconds/);

  // More than twice the AI stage budget spent in the stage itself: flagged.
  await advance(60);
  assert.match(container.querySelector('.progress-time').textContent, /Taking longer than usual/);

  await view.unmount();
  dom.window.close();
});

test('the live region is not re-announced for the queue\'s elapsed-seconds counter (issue #311)', async () => {
  const dom = installDom();
  const container = dom.window.document.getElementById('root');
  const startTime = now;
  // The queued messages windbgService sends on every 10 s poll.
  const view = await mountTracked(container, { stage: 'queued', message: 'Waiting for WinDBG server... (10s)', startTime });
  const region = container.querySelector('[role="status"]');
  let mutations = 0;
  const observer = new dom.window.MutationObserver(records => { mutations += records.length; });
  observer.observe(region, { childList: true, characterData: true, subtree: true });
  const settle = () => harness.act(async () => { await new Promise(r => setImmediate(r)); });
  const announced = () => region.textContent.replace(/\s+/g, ' ').trim();

  assert.equal(announced(), 'Queued for Analysis. Waiting for WinDBG server...');
  for (const s of [20, 30, 40]) {
    await view.render({ stage: 'queued', message: `Waiting for WinDBG server... (${s}s)`, startTime });
  }
  await settle();
  assert.equal(mutations, 0, 'elapsed-counter updates do not touch the live region');
  assert.match(container.querySelector('.progress-description').textContent, /\(40s\)/, 'the visible text keeps the counter');

  await view.render({ stage: 'queued', message: 'Queued for analysis (position 3) — 50s elapsed', startTime });
  await settle();
  assert.equal(announced(), 'Queued for Analysis. Queued for analysis (position 3)');
  const afterPosition = mutations;
  assert.ok(afterPosition > 0, 'a queue position change is announced');
  await view.render({ stage: 'queued', message: 'Queued for analysis (position 3) — 60s elapsed', startTime });
  await settle();
  assert.equal(mutations, afterPosition, 'the same position with a new counter is not re-announced');

  await view.render({ stage: 'processing', message: 'WinDBG is analyzing your dump file...', startTime });
  await settle();
  assert.equal(announced(), 'WinDBG Analysis in Progress. WinDBG is analyzing your dump file...');
  assert.ok(mutations > afterPosition, 'a stage change is announced');

  observer.disconnect();
  await view.unmount();
  dom.window.close();
});
