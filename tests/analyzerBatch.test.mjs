import test, { after } from 'node:test';
import { createMountTracker, failFileAfter, JSDOM_FILE_TIMEOUT_MS } from './helpers/jsdomCleanup.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rolldown } from 'rolldown';
import { JSDOM } from 'jsdom';

// The 10-file cap is per batch, not per page load, and finished results can
// be removed (issue #370). Renders the real AnalysisResults / report cards and
// drives the real useFileProcessor hook in jsdom.
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const file = (...parts) => JSON.stringify(path.join(root, ...parts));
const HARNESS = `
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import AnalysisResults from ${file('components', 'AnalysisResults.tsx')};
import { useFileProcessor } from ${file('hooks', 'useFileProcessor.tsx')};
import { countBatchFiles, validateFileCount, validateFiles } from ${file('utils', 'fileValidation.ts')};
import { FileStatus } from ${file('types.ts')};

export async function mountResults(container, props) {
  const r = createRoot(container);
  await act(async () => {
    r.render(React.createElement(MemoryRouter, null, React.createElement(AnalysisResults, props)));
  });
  return () => act(() => r.unmount());
}

export async function mountProcessor(container, out) {
  function Probe() {
    const processor = useFileProcessor();
    out.addFilesToState = processor.addFilesToState;
    out.processFiles = processor.processFiles;
    out.error = processor.error;
    return null;
  }
  const r = createRoot(container);
  await act(async () => { r.render(React.createElement(Probe)); });
  return () => act(() => r.unmount());
}
export { act, FileStatus, countBatchFiles, validateFileCount, validateFiles };
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

const h = await loadHarness();
const { act, FileStatus } = h;
failFileAfter(JSDOM_FILE_TIMEOUT_MS, 'analyzerBatch.test.mjs');
const track = createMountTracker();

function dumpFile(id, status, extra = {}) {
  return {
    id,
    file: { name: `${id}.dmp`, size: 65536, lastModified: 1 },
    displayName: `${id}.dmp`,
    sourcePath: `${id}.dmp`,
    status,
    dumpType: 'minidump',
    ...(status === FileStatus.ERROR ? { error: 'WinDBG failed' } : {}),
    ...extra
  };
}

const finished = n => Array.from({ length: n }, (_, i) => dumpFile(`done${i}`, i % 3 === 0 ? FileStatus.ERROR : FileStatus.ANALYZED));

test('only pending and analyzing files count toward the batch cap', () => {
  const files = [
    ...finished(10),
    dumpFile('p1', FileStatus.PENDING),
    dumpFile('a1', FileStatus.ANALYZING)
  ];
  assert.equal(h.countBatchFiles(files), 2);
  assert.equal(h.countBatchFiles([]), 0);
});

test('the cap message says one batch, not one session', () => {
  const result = h.validateFileCount(10, 1);
  assert.equal(result.valid, false);
  assert.equal(result.error, 'Too many files. Maximum 10 files can be analyzed in one batch.');
  assert.equal(h.validateFileCount(9, 1).valid, true);
});

test('after ten finished analyses an eleventh file is still accepted; ten pending ones are the cap', async () => {
  const dom = installDom();
  const out = {};
  const unmount = track(await h.mountProcessor(dom.window.document.getElementById('root'), out));

  const next = dumpFile('s10', FileStatus.PENDING);
  let state;
  await act(async () => { state = out.addFilesToState([next], finished(10)); });
  assert.equal(state.length, 11);
  assert.equal(state.at(-1).id, 's10');
  assert.equal(out.error, null);

  const pending = Array.from({ length: 10 }, (_, i) => dumpFile(`p${i}`, FileStatus.PENDING));
  await act(async () => { state = out.addFilesToState([dumpFile('p10', FileStatus.PENDING)], [...finished(3), ...pending]); });
  assert.equal(state.length, 13, 'the eleventh pending file is refused');
  assert.equal(out.error, 'Too many files. Maximum 10 files can be analyzed in one batch.');
  await unmount();
  dom.window.close();
});

test('finished and failed results have a keyboard-reachable Remove button; running ones do not', async () => {
  const dom = installDom();
  const removed = [];
  const files = [
    dumpFile('ok', FileStatus.ANALYZED, { report: { summary: 's', probableCause: 'c', culprit: 'x.sys', recommendations: [] } }),
    dumpFile('bad', FileStatus.ERROR),
    dumpFile('run', FileStatus.ANALYZING)
  ];
  const container = dom.window.document.getElementById('root');
  const unmount = track(await h.mountResults(container, { dumpFiles: files, onRemove: id => removed.push(id) }));

  const buttons = [...container.querySelectorAll('button.result-remove')];
  assert.deepEqual(buttons.map(b => b.getAttribute('aria-label')), ['Remove report for ok.dmp', 'Remove report for bad.dmp']);
  for (const button of buttons) {
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(button.getAttribute('type'), 'button');
    assert.notEqual(button.tabIndex, -1);
  }
  await act(async () => { buttons[1].click(); });
  assert.deepEqual(removed, ['bad']);
  await unmount();
  dom.window.close();
});

test('"Clear finished results" appears only with finished results and clears them', async () => {
  const dom = installDom();
  let cleared = 0;
  const container = dom.window.document.getElementById('root');
  const files = [dumpFile('bad', FileStatus.ERROR), dumpFile('run', FileStatus.ANALYZING)];
  let unmount = track(await h.mountResults(container, { dumpFiles: files, onRemove: () => {}, onClearFinished: () => { cleared += 1; } }));
  const clear = [...container.querySelectorAll('button')].find(b => b.textContent.trim() === 'Clear finished results');
  assert.ok(clear, 'shown');
  assert.equal(clear.getAttribute('type'), 'button');
  await act(async () => { clear.click(); });
  assert.equal(cleared, 1);
  await unmount();

  unmount = track(await h.mountResults(container, { dumpFiles: [dumpFile('run', FileStatus.ANALYZING)], onRemove: () => {}, onClearFinished: () => {} }));
  assert.equal([...container.querySelectorAll('button')].some(b => b.textContent.trim() === 'Clear finished results'), false);
  await unmount();
  dom.window.close();
});
