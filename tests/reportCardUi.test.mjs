import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rolldown } from 'rolldown';
import { JSDOM } from 'jsdom';

// Renders the real AnalysisReportCard and Loader (React bundled in, one
// instance) into jsdom.
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const file = (...parts) => JSON.stringify(path.join(root, ...parts));
const HARNESS = `
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import AnalysisReportCard from ${file('components', 'AnalysisReportCard.tsx')};
import Loader from ${file('components', 'Loader.tsx')};
import { FileStatus } from ${file('types.ts')};

export async function mountCard(container, dumpFile) {
  const r = createRoot(container);
  await act(async () => {
    r.render(React.createElement(MemoryRouter, null, React.createElement(AnalysisReportCard, { dumpFile })));
  });
  return () => act(() => r.unmount());
}
export const loaderMarkup = props => renderToStaticMarkup(React.createElement(Loader, props));
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

function analyzedFile(overrides = {}) {
  return {
    id: 'f1',
    file: { name: 'crash.dmp' },
    status: harness.FileStatus.ANALYZED,
    dumpType: 'minidump',
    analysisMethod: 'windbg',
    report: {
      summary: 'Driver fault.',
      probableCause: 'A driver fault.',
      culprit: 'nvlddmkm.sys',
      recommendations: [],
      callStack: [{ address: 'fffff801`00001234', module: 'nvlddmkm', function: 'Foo', offset: '0x10' }],
      rawWinDbgOutput: 'BUGCHECK_CODE: 116',
    },
    ...overrides,
  };
}

test('Call Stack and Raw WinDBG Output toggles are real buttons inside their headings (issue #156)', async () => {
  const dom = installDom();
  const container = dom.window.document.getElementById('root');
  const unmount = await harness.mountCard(container, analyzedFile());

  for (const [label, panelId] of [['Call Stack', 'call-stack-f1'], ['Raw WinDBG Output', 'raw-windbg-f1']]) {
    const heading = [...container.querySelectorAll('h3')].find(h => h.textContent.includes(label));
    assert.ok(heading, label);
    assert.equal(heading.getAttribute('role'), null, `${label}: the heading keeps heading semantics`);
    const toggle = heading.querySelector('button');
    assert.ok(toggle, `${label}: toggle is a <button> (focusable, Enter/Space activate it)`);
    assert.equal(toggle.type, 'button');
    assert.equal(toggle.getAttribute('aria-controls'), panelId);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(dom.window.document.getElementById(panelId), null);

    await harness.act(async () => { toggle.click(); });
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.ok(dom.window.document.getElementById(panelId), `${label}: the controlled panel is rendered`);
  }
  await unmount();
  dom.window.close();
});

test('the inline Loader is just the spinner; only the route fallback fills the viewport (issue #157)', async () => {
  assert.equal(harness.loaderMarkup({}), '<div class="loader"></div>');
  assert.match(harness.loaderMarkup({ fullPage: true }), /min-height:100vh/);

  const dom = installDom();
  const container = dom.window.document.getElementById('root');
  const unmount = await harness.mountCard(container, analyzedFile({ status: harness.FileStatus.ANALYZING, report: undefined }));
  assert.ok(container.querySelector('.status-analyzing .loader'), 'the status pill still shows the spinner');
  assert.doesNotMatch(container.innerHTML, /100vh/);
  await unmount();
  dom.window.close();
});
