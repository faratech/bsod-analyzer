import test, { after } from 'node:test';
import { createMountTracker, failFileAfter, JSDOM_FILE_TIMEOUT_MS } from './helpers/jsdomCleanup.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rolldown } from 'rolldown';
import { JSDOM } from 'jsdom';

// pages/Analyzer.tsx mounted whole in jsdom (issue #382): the #370 wiring
// (per-batch file count, Clear finished results) is checked on the page
// itself, not only on the components it composes. The uploader, the file
// processor, the session, the analysis service and the ads are stubbed;
// AnalysisResults, the report cards and useAnalysis are real.
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const file = (...parts) => JSON.stringify(path.join(root, ...parts));

// Modules replaced by stubs, by import specifier (as written in the source).
// Each stub reads its behaviour from globalThis.__analyzerStubs.
const STUBS = {
  '../components/FileUploader': `
    import React from 'react';
    export default function FileUploader(props) {
      globalThis.__analyzerStubs.uploader = props;
      return React.createElement('div', { 'data-testid': 'uploader', 'data-count': String(props.currentFileCount) });
    }`,
  '../hooks/useFileProcessor': `
    export function useFileProcessor() {
      const s = globalThis.__analyzerStubs;
      return {
        processFiles: async (files, currentCount, track) => { s.processCalls.push(currentCount); return s.nextFiles.splice(0); },
        addFilesToState: (newFiles, prev) => [...prev, ...newFiles],
        error: null,
      };
    }`,
  '../utils/sessionManager': `
    const listeners = new Set();
    globalThis.__analyzerStubs.invalidate = () => { for (const l of [...listeners]) l(); };
    export const initializeSession = (...args) => globalThis.__analyzerStubs.initializeSession(...args);
    export const onSessionInvalid = l => { listeners.add(l); return () => listeners.delete(l); };
    export const startSessionRefresh = () => {};
    export const stopSessionRefresh = () => {};`,
  '../services/geminiProxy': `
    export const analyzeDumpFiles = (...args) => globalThis.__analyzerStubs.analyzeDumpFiles(...args);`,
  '../components/AdSense': `
    export const VerticalAd = () => null;
    export const InFeedAd = () => null;`,
  '../components/AdSenseWithSizeCheck': `
    export const DisplayAdSafe = () => null;
    export const SafeAd = () => null;`,
  '../components/SEO': 'export default () => null;',
  '../components/StructuredData': 'export default () => null;',
  '../hooks/useAnalytics': `
    export const useAnalytics = () => ({ trackFileUpload() {}, trackAnalysisStart() {}, trackAnalysisComplete() {} });`,
};

const HARNESS = `
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import Analyzer from ${file('pages', 'Analyzer.tsx')};
import { FileStatus } from ${file('types.ts')};

export async function mountAnalyzer(container) {
  const r = createRoot(container);
  await act(async () => {
    r.render(React.createElement(MemoryRouter, null, React.createElement(Analyzer)));
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
    transform: { define: { 'process.env.NODE_ENV': '"development"', __BUILD_VERSION__: '"test"' } },
    plugins: [{
      name: 'harness',
      resolveId: (id, importer) => {
        if (id === 'harness') return id;
        // Only the page's and its hooks' imports: other modules keep theirs.
        const fromPageOrHook = /[\\/](pages|hooks)[\\/][^\\/]+$/.test(importer ?? '');
        return fromPageOrHook && Object.hasOwn(STUBS, id) ? `\0stub:${id}` : null;
      },
      load: id => (id === 'harness' ? HARNESS : id.startsWith('\0stub:') ? STUBS[id.slice('\0stub:'.length)] : null),
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

function resetStubs() {
  globalThis.__analyzerStubs = {
    ...globalThis.__analyzerStubs,
    uploader: null,
    processCalls: [],
    nextFiles: [],
    initializeSession: async () => true,
    analyzeDumpFiles: async () => {},
  };
  return globalThis.__analyzerStubs;
}
resetStubs();

function installDom() {
  const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', { url: 'https://bsod.windowsforum.com/analyzer', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent']) {
    Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : dom.window[key], configurable: true, writable: true });
  }
  dom.window.confirm = () => true;
  dom.window.scrollTo = () => {};
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
  return dom;
}

const h = await loadHarness();
const { act, FileStatus } = h;
failFileAfter(JSDOM_FILE_TIMEOUT_MS, 'analyzerPage.test.mjs');
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
    ...(status === FileStatus.ANALYZED ? { report: { summary: 's', probableCause: 'c', culprit: 'x.sys', recommendations: [] } } : {}),
    ...extra
  };
}

const finished = n => Array.from({ length: n }, (_, i) => dumpFile(`done${i}`, i % 3 === 0 ? FileStatus.ERROR : FileStatus.ANALYZED));

// Adds files through the (stubbed) uploader, as a drop would.
async function addFiles(stubs, files) {
  stubs.nextFiles.push(...files);
  await act(async () => { await stubs.uploader.onFilesAdded(files.map(f => f.file)); });
}

async function mountPage() {
  const dom = installDom();
  const stubs = resetStubs();
  const container = dom.window.document.getElementById('root');
  const unmount = track(await h.mountAnalyzer(container));
  return { dom, stubs, container, unmount };
}

const cards = container => [...container.querySelectorAll('.result-remove')].map(b => b.getAttribute('aria-label'));
const button = (container, text) => [...container.querySelectorAll('button')].find(b => b.textContent.trim() === text);

test('the page counts only the files of the current batch toward the cap (issue #370, #382)', async () => {
  const { dom, stubs, container, unmount } = await mountPage();
  assert.equal(stubs.uploader.currentFileCount, 0);

  await addFiles(stubs, finished(10));
  assert.equal(stubs.uploader.currentFileCount, 0, 'finished results do not count toward the uploader cap');
  assert.equal(container.querySelector('[data-testid="uploader"]').dataset.count, '0');

  await addFiles(stubs, [dumpFile('p1', FileStatus.PENDING)]);
  assert.deepEqual(stubs.processCalls, [0, 0], 'processFiles gets the batch count, not the page count');
  assert.equal(stubs.uploader.currentFileCount, 1);

  await addFiles(stubs, [dumpFile('p2', FileStatus.PENDING)]);
  assert.deepEqual(stubs.processCalls, [0, 0, 1]);
  assert.equal(stubs.uploader.currentFileCount, 2);
  await unmount();
  dom.window.close();
});

test('"Clear finished results" on the page drops finished and failed results and keeps the batch (issue #370, #382)', async () => {
  const { dom, stubs, container, unmount } = await mountPage();
  await addFiles(stubs, [...finished(3), dumpFile('p1', FileStatus.PENDING)]);
  assert.equal(cards(container).length, 3);
  assert.ok(container.querySelector('.file-preview-list').textContent.includes('p1.dmp'));

  const clear = button(container, 'Clear finished results');
  assert.ok(clear, 'the page wires onClearFinished');
  await act(async () => { clear.click(); });
  assert.deepEqual(cards(container), [], 'finished results are gone');
  assert.equal(button(container, 'Clear finished results'), undefined);
  assert.ok(container.querySelector('.file-preview-list').textContent.includes('p1.dmp'), 'the pending file stays');
  assert.equal(stubs.uploader.currentFileCount, 1);
  await unmount();
  dom.window.close();
});

// Issue #380: Retry (and Analyze) awaited the session check, often seconds
// with Turnstile, while the file was still removable, then uploaded and
// analyzed it anyway. The file is now marked ANALYZING before that await.
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('a file being retried cannot be removed or cleared while the session check is pending (issue #380)', async () => {
  const { dom, stubs, container, unmount } = await mountPage();
  await addFiles(stubs, [dumpFile('bad', FileStatus.ERROR), dumpFile('ok', FileStatus.ANALYZED)]);
  const session = deferred();
  stubs.initializeSession = () => session.promise;
  const analyzed = [];
  stubs.analyzeDumpFiles = async files => { analyzed.push(files.map(f => f.id)); };

  await act(async () => { button(container, '↻ Retry Analysis').click(); });
  assert.deepEqual(cards(container), ['Remove report for ok.dmp'], 'the retried card offers no Remove');
  await act(async () => { button(container, 'Clear finished results').click(); });
  assert.deepEqual(analyzed, [], 'nothing is uploaded before the session is ready');

  await act(async () => { session.resolve(true); await session.promise; });
  assert.deepEqual(analyzed, [['bad']], 'the retried file, kept through Clear, is analyzed');
  await unmount();
  dom.window.close();
});

test('a failed session check during a retry puts the file back as failed and removable (issue #380)', async () => {
  const { dom, stubs, container, unmount } = await mountPage();
  await addFiles(stubs, [dumpFile('bad', FileStatus.ERROR)]);
  stubs.initializeSession = async () => false;
  let calls = 0;
  stubs.analyzeDumpFiles = async () => { calls += 1; };
  await act(async () => { button(container, '↻ Retry Analysis').click(); });
  assert.equal(calls, 0);
  assert.deepEqual(cards(container), ['Remove report for bad.dmp']);
  assert.match(container.textContent, /Security check expired/);
  await unmount();
  dom.window.close();
});

test('pending files leave the removable preview list while Analyze waits for the session (issue #380)', async () => {
  const { dom, stubs, container, unmount } = await mountPage();
  await addFiles(stubs, [dumpFile('p1', FileStatus.PENDING), dumpFile('p2', FileStatus.PENDING)]);
  const session = deferred();
  stubs.initializeSession = () => session.promise;
  const analyzed = [];
  stubs.analyzeDumpFiles = async files => { analyzed.push(files.map(f => f.id)); };

  await act(async () => { button(container, 'Analyze 2 New File(s)').click(); });
  const previews = container.querySelector('.file-preview-list');
  assert.equal(previews.textContent.includes('p1.dmp'), false, 'no remove control for a file about to upload');
  assert.equal(stubs.uploader.currentFileCount, 2, 'still counted in the batch');
  await act(async () => { session.resolve(true); await session.promise; });
  assert.deepEqual(analyzed, [['p1', 'p2']]);
  await unmount();
  dom.window.close();
});

test('a failed session check before Analyze puts the files back as pending (issue #380)', async () => {
  const { dom, stubs, container, unmount } = await mountPage();
  await addFiles(stubs, [dumpFile('p1', FileStatus.PENDING)]);
  stubs.initializeSession = async () => false;
  let calls = 0;
  stubs.analyzeDumpFiles = async () => { calls += 1; };
  await act(async () => { button(container, 'Analyze 1 New File(s)').click(); });
  assert.equal(calls, 0);
  assert.ok(container.querySelector('.file-preview-list').textContent.includes('p1.dmp'), 'back in the pending list');
  assert.ok(button(container, 'Analyze 1 New File(s)'), 'and can be analyzed again');
  await unmount();
  dom.window.close();
});

// Issue #379: Remove and Clear finished results unmounted the button that
// had focus, dropping it to <body>, and announced nothing.
const liveText = container => [...container.querySelectorAll('[role="status"][aria-live="polite"]')].map(el => el.textContent.trim()).filter(Boolean);
const toggleOf = (container, id) => container.querySelector(`[aria-controls="report-content-${id}"]`);
async function clickFocused(dom, element) {
  element.focus();
  assert.equal(dom.window.document.activeElement, element);
  await act(async () => { element.click(); });
}

test('Remove moves focus to the next report, else the previous, else the page heading, and announces it (issue #379)', async () => {
  const { dom, stubs, container, unmount } = await mountPage();
  await addFiles(stubs, [dumpFile('a', FileStatus.ANALYZED), dumpFile('b', FileStatus.ERROR), dumpFile('c', FileStatus.ANALYZED)]);
  const doc = dom.window.document;
  const removeOf = id => container.querySelector(`.result-remove[aria-label="Remove report for ${id}.dmp"]`);

  await clickFocused(dom, removeOf('b'));
  assert.equal(doc.activeElement, toggleOf(container, 'c'), 'the next report');
  assert.ok(liveText(container).includes('Report for b.dmp removed'), liveText(container).join('|'));

  await clickFocused(dom, removeOf('c'));
  assert.equal(doc.activeElement, toggleOf(container, 'a'), 'the previous report when it was the last');
  assert.ok(liveText(container).includes('Report for c.dmp removed'));

  await clickFocused(dom, removeOf('a'));
  assert.notEqual(doc.activeElement, doc.body, 'focus is not dropped');
  assert.equal(doc.activeElement.tagName, 'H1', 'the page heading when no report is left');
  assert.equal(doc.activeElement.getAttribute('tabindex'), '-1');
  assert.ok(liveText(container).includes('Report for a.dmp removed'), 'announced though the results section is gone');
  await unmount();
  dom.window.close();
});

test('Clear finished results moves focus to the results heading, or the page heading, and announces the count (issue #379)', async () => {
  const { dom, stubs, container, unmount } = await mountPage();
  const doc = dom.window.document;
  await addFiles(stubs, [dumpFile('a', FileStatus.ANALYZED), dumpFile('b', FileStatus.ERROR), dumpFile('run', FileStatus.ANALYZING)]);
  await clickFocused(dom, button(container, 'Clear finished results'));
  assert.equal(doc.activeElement.tagName, 'H2', 'the results heading while a report remains');
  assert.equal(doc.activeElement.textContent, 'Analysis Results');
  assert.equal(doc.activeElement.getAttribute('tabindex'), '-1');
  assert.ok(liveText(container).includes('Cleared 2 finished reports'), liveText(container).join('|'));
  await unmount();
  dom.window.close();

  const second = await mountPage();
  await addFiles(second.stubs, [dumpFile('a', FileStatus.ANALYZED)]);
  await clickFocused(second.dom, button(second.container, 'Clear finished results'));
  assert.equal(second.dom.window.document.activeElement.tagName, 'H1');
  assert.ok(liveText(second.container).includes('Cleared 1 finished report'));
  await second.unmount();
  second.dom.window.close();
});
