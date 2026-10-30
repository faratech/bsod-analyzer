import test, { after } from 'node:test';
import { createMountTracker, failFileAfter, JSDOM_FILE_TIMEOUT_MS } from './helpers/jsdomCleanup.mjs';
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

// Unmount every root even when an assertion fails, so the component's timers
// cannot keep this file alive (issue #321).
failFileAfter(JSDOM_FILE_TIMEOUT_MS, 'reportCardUi.test.mjs');
const track = createMountTracker();
const mountCard = async (...args) => track(await harness.mountCard(...args));

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
  const unmount = await mountCard(container, analyzedFile());

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
  const unmount = await mountCard(container, analyzedFile({ status: harness.FileStatus.ANALYZING, report: undefined }));
  assert.ok(container.querySelector('.status-analyzing .loader'), 'the status pill still shows the spinner');
  assert.doesNotMatch(container.innerHTML, /100vh/);
  await unmount();
  dom.window.close();
});

test('the report expand toggle is named and collapsed content is inert (issue #249)', async () => {
  const dom = installDom();
  const container = dom.window.document.getElementById('root');
  const unmount = await mountCard(container, analyzedFile());

  const toggle = container.querySelector('button[aria-controls="report-content-f1"]');
  assert.ok(toggle);
  const region = dom.window.document.getElementById('report-content-f1');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.getAttribute('aria-label'), 'Collapse report for crash.dmp');
  assert.equal(region.hasAttribute('inert'), false);
  assert.equal(region.getAttribute('aria-hidden'), null);

  await harness.act(async () => { toggle.click(); });
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-label'), 'Expand report for crash.dmp');
  assert.equal(region.hasAttribute('inert'), true, 'collapsed content leaves the tab order');
  assert.equal(region.getAttribute('aria-hidden'), 'true', 'and the accessibility tree');

  await harness.act(async () => { toggle.click(); });
  assert.equal(region.hasAttribute('inert'), false);
  await unmount();
  dom.window.close();
});

test('a long unbroken archive path stays inside the card header and keeps the toggle visible (issue #299)', async () => {
  const dom = installDom();
  const container = dom.window.document.getElementById('root');
  const longName = 'Crash_Dumps_From_Gaming_PC_2026_10_30_backup.zip/MEMORY_DUMP_WITH_A_VERY_LONG_NAME_103024-12345-01.dmp';
  const unmount = await mountCard(container, analyzedFile({ displayName: longName }));

  const header = container.querySelector('.result-header');
  const group = header.firstElementChild;
  assert.ok(group.contains(container.querySelector('.result-filename')));
  assert.ok(group.classList.contains('result-header-main'), 'the left group is a named class so styles.css can let it shrink');
  const toggle = header.querySelector('button[aria-controls="report-content-f1"]');
  assert.ok(toggle.classList.contains('result-toggle'));
  assert.equal(toggle.parentElement, header);
  await unmount();
  dom.window.close();
});

test('the report header prints the size with the same formatter as the file list (issue #301)', async () => {
  const dom = installDom();
  const container = dom.window.document.getElementById('root');
  const big = { name: 'MEMORY.DMP', size: 2 * 1024 * 1024 * 1024 };
  const unmount = await mountCard(container, analyzedFile({ file: big }));
  const header = container.querySelector('.result-header').textContent;
  assert.match(header, /\(2\.0 GB\)/);
  assert.doesNotMatch(header, /2097152/);
  await unmount();
  dom.window.close();
});

// Issue #332: the bug check name is one unbroken token
// (SYSTEM_THREAD_EXCEPTION_NOT_HANDLED_M) wider than the card on a phone, and
// was clipped; a long driver name in the problematic-drivers list overflowed
// the same way.
test('long bug check and driver names may break inside their flex rows (issue #332)', async () => {
  const dom = installDom();
  const container = dom.window.document.getElementById('root');
  const name = 'SYSTEM_THREAD_EXCEPTION_NOT_HANDLED_M';
  const driver = 'ExampleVendorKernelSecurityFilterDriver64.sys';
  const base = analyzedFile();
  const unmount = await mountCard(container, analyzedFile({
    report: {
      ...base.report,
      bugCheck: { code: '0x1000007E', name, parameters: [] },
      driverWarnings: [{ driverName: driver, displayName: 'Example filter', manufacturer: 'Example', category: 'security', isAssociatedWithBugCheck: true }]
    }
  }));

  const breakable = (span, label) => {
    assert.ok(span, label);
    assert.equal(span.style.overflowWrap, 'anywhere', `${label}: overflow-wrap`);
    assert.match(span.style.minWidth, /^0(px)?$/, `${label}: min-width`);
    const row = span.parentElement;
    assert.equal(row.style.display, 'flex', `${label}: sits in a flex row`);
    assert.match(row.style.minWidth, /^0(px)?$/, `${label}: the row may shrink`);
  };
  const spans = [...container.querySelectorAll('span')];
  breakable(spans.find(s => s.textContent === name), 'bug check name');
  breakable(spans.find(s => s.textContent === driver), 'driver name');
  await unmount();
  dom.window.close();
});

// Issue #339: #332 fixed only the bug check name and the driver name. The
// parameter rows (decoded meanings that start with one long token such as
// FAST_FAIL_STACK_COOKIE_CHECK_FAILURE:, 18-char hex values in a fixed 140px
// slot) and every other data token in the card were still clipped at 390px.
test('parameter rows and every other data token in the card may break (issue #339)', async () => {
  const dom = installDom();
  const container = dom.window.document.getElementById('root');
  const mod = 'ExampleVendorKernelSecurityFilterDriver64.sys';
  const meaning = 'Security Check Type: FAST_FAIL_STACK_COOKIE_CHECK_FAILURE: stack cookie instrumentation detected an overrun';
  const value = '0xFFFFA80112345678';
  const base = analyzedFile();
  const unmount = await mountCard(container, analyzedFile({
    report: {
      ...base.report,
      bugCheck: { code: '0x00000139', name: 'KERNEL_SECURITY_CHECK_FAILURE', parameters: [{ value, meaning }] },
      systemInfo: { processName: 'SomeVeryLongProcessNameForTesting_Service64.exe', windowsVersion: '10.0.26100.8246_(WinBuild.160101.0800_amd64fre)' },
      parameterAnalysis: [{ parameter: 'Parameter_1_long', rawValue: value, decoded: 'NONPAGED_BUGCHECK_USER_VA_ACCESS_INCONSISTENT', significance: 'FAST_FAIL_STACK_COOKIE_CHECK_FAILURE' }],
      hardwareError: { isHardwareError: true, errorType: 'MACHINE_CHECK_EXCEPTION_PROCESSOR_CACHE', component: 'GenuineIntel_Family6_Model183_Stepping1', severity: 'fatal', details: ['MCi_STATUS=0xBE00000000800400_MCi_ADDR=0x0'], recommendations: [] },
      crashLocation: { module: mod, address: 'fffff801`12345678', offset: '+0x1234567' },
      loadedModules: [{ name: mod, base: 'fffff801`12340000', isCulprit: true }],
      driverWarnings: [{ driverName: mod, displayName: 'Example_filter_display_name_v64', manufacturer: 'Example', category: 'security', issues: ['Known_issue_token_without_spaces'], recommendations: ['Update_the_driver_now'], isAssociatedWithBugCheck: true }],
      callStack: [{ address: 'ffffa801`12345678', module: 'ExampleVendorKernelSecurityFilterDriver64', function: 'ExampleFunctionWithAVeryLongName', offset: '0x1234567' }],
    }
  }));

  // Parameter row: wraps, the description may shrink and break, the value may break.
  const spans = [...container.querySelectorAll('span')];
  const desc = spans.find(s => s.textContent === meaning);
  assert.ok(desc, 'parameter description');
  assert.equal(desc.style.overflowWrap, 'anywhere', 'description: overflow-wrap');
  assert.match(desc.style.minWidth, /^0(px)?$/, 'description: min-width');
  assert.match(desc.style.flex, /^1 1 /, 'description: takes the rest of the row');
  const row = desc.parentElement;
  assert.equal(row.style.display, 'flex');
  assert.equal(row.style.flexWrap, 'wrap', 'row wraps so the description drops under the value on a phone');
  const val = spans.find(s => s.textContent === value && s.parentElement === row);
  assert.ok(val, 'parameter value');
  assert.equal(val.style.overflowWrap, 'anywhere', 'value: overflow-wrap');
  assert.equal(val.style.maxWidth, '100%', 'value: never wider than the row');

  // Open the call stack so its frames render.
  const stackToggle = [...container.querySelectorAll('h3 button')].find(b => b.textContent.includes('Call Stack'));
  await harness.act(async () => { stackToggle.click(); });

  // Every leaf element showing one of these tokens must be able to break:
  // overflow-wrap (inherited) anywhere or word-break: break-all on itself or an
  // ancestor inside the card.
  // The overview section styles its facts through styles.css classes: accept a
  // class only when its rule there breaks long words.
  const css = await import('node:fs').then(fs => fs.readFileSync(path.join(root, 'styles.css'), 'utf8'));
  const classBreaks = new Map();
  const ruleBreaks = selector => {
    const at = css.indexOf(`${selector} {`);
    if (at < 0) return false;
    const block = css.slice(at, css.indexOf('}', at));
    return /overflow-wrap:\s*anywhere|word-break:\s*break-(all|word)/.test(block);
  };
  const breaksByClass = n => [...(n.classList || [])].some(c => {
    if (!classBreaks.has(c)) classBreaks.set(c, ruleBreaks(`.${c}`));
    return classBreaks.get(c);
  }) || (n.tagName === 'CODE' && n.parentElement?.classList.contains('culprit-line') && ruleBreaks('.culprit-line code'));
  const canBreak = el => {
    for (let n = el; n && n !== container; n = n.parentElement) {
      if (n.style?.overflowWrap === 'anywhere' || n.style?.wordBreak === 'break-all' || breaksByClass(n)) return true;
    }
    return false;
  };
  const tokens = [mod, 'SomeVeryLongProcessNameForTesting_Service64.exe', '10.0.26100.8246_(WinBuild.160101.0800_amd64fre)',
    'NONPAGED_BUGCHECK_USER_VA_ACCESS_INCONSISTENT', 'FAST_FAIL_STACK_COOKIE_CHECK_FAILURE', 'Parameter_1_long',
    'MACHINE_CHECK_EXCEPTION_PROCESSOR_CACHE', 'GenuineIntel_Family6_Model183_Stepping1', 'MCi_STATUS=0xBE00000000800400_MCi_ADDR=0x0',
    'Example_filter_display_name_v64', 'Known_issue_token_without_spaces', 'Update_the_driver_now',
    'ExampleVendorKernelSecurityFilterDriver64', 'ExampleFunctionWithAVeryLongName', 'ffffa801`12345678', 'fffff801`12340000', value];
  const card = container.querySelector('#report-content-f1');
  const leaves = [...card.querySelectorAll('*')].filter(el => [...el.childNodes].some(c => c.nodeType === 3 && c.textContent.trim()));
  for (const token of tokens) {
    const hits = leaves.filter(el => el.textContent.includes(token) && ![...el.children].some(c => c.textContent.includes(token)));
    assert.ok(hits.length > 0, `${token}: rendered`);
    for (const el of hits) assert.ok(canBreak(el), `${token} in <${el.tagName.toLowerCase()}>: may break`);
  }
  await unmount();
  dom.window.close();
});
