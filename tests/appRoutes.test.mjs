import test, { after } from 'node:test';
import { createMountTracker, failFileAfter, JSDOM_FILE_TIMEOUT_MS } from './helpers/jsdomCleanup.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { rolldown } from 'rolldown';
import { JSDOM } from 'jsdom';

// Bundles the real app shell (entry-server.tsx: the prerender's renderAsync,
// plus the client tree) into one module with every lazy route inlined, so the
// tests exercise the same routes the build prerenders and the client hydrates.
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const file = (...parts) => JSON.stringify(path.join(root, ...parts));
const HARNESS = `
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AppShell } from ${file('AppRouter.tsx')};
export { renderAsync } from ${file('entry-server.tsx')};

export async function mountApp(container) {
  const r = createRoot(container);
  await act(async () => {
    r.render(React.createElement(BrowserRouter, null, React.createElement(AppShell)));
  });
  return () => act(() => r.unmount());
}
export { act };
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bsod-app-routes-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function loadHarness() {
  const bundle = await rolldown({
    input: 'harness',
    platform: 'node',
    logLevel: 'silent',
    transform: {
      define: {
        'process.env.NODE_ENV': '"development"',
        __BUILD_TIMESTAMP__: '0',
        __BUILD_VERSION__: '"test"',
        __BUILD_YEAR__: '2026',
      },
    },
    plugins: [{
      name: 'harness',
      resolveId: id => (id === 'harness' ? id : null),
      load: id => (id === 'harness' ? HARNESS : null),
    }, {
      name: 'no-css',
      load: id => (id.endsWith('.css') ? '' : null),
    }],
  });
  const out = path.join(tmp, 'harness.mjs');
  await bundle.write({ format: 'esm', file: out, codeSplitting: false });
  return import(pathToFileURL(out).href);
}

// Browser-like globals the shell's effects touch.
const NoopObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
function installDom(url) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>', {
    url,
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.IntersectionObserver = NoopObserver;
  window.ResizeObserver = NoopObserver;
  window.requestIdleCallback = cb => setTimeout(() => cb({ timeRemaining: () => 0, didTimeout: true }), 0);
  const store = new Map();
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
    clear: () => store.clear(),
  };
  Object.defineProperty(window, 'localStorage', { value: localStorage, configurable: true });
  const globals = {
    window, document: window.document, navigator: window.navigator, localStorage,
    HTMLElement: window.HTMLElement, Node: window.Node, Event: window.Event, MouseEvent: window.MouseEvent,
    IntersectionObserver: NoopObserver, ResizeObserver: NoopObserver,
    requestAnimationFrame: cb => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: id => clearTimeout(id),
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  return dom;
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

installDom('https://bsod.windowsforum.com/');
const harness = await loadHarness();

// Unmount every root even when an assertion fails, so the component's timers
// cannot keep this file alive (issue #321).
failFileAfter(JSDOM_FILE_TIMEOUT_MS, 'appRoutes.test.mjs');
const track = createMountTracker();
const mountApp = async (...args) => track(await harness.mountApp(...args));

// Runs before the server renders: the bundle shares one React between the
// server and client renderers, so keep the client mount first and isolated.
test('in-app navigation to /about#how-it-works ends scrolled to the section (issue #239)', async () => {
  const dom = installDom('https://bsod.windowsforum.com/about');
  const { window } = dom;
  const calls = [];
  window.scrollTo = (...args) => { calls.push(['scrollTo', args]); };
  window.Element.prototype.scrollIntoView = function () { calls.push(['scrollIntoView', this.id]); };

  const container = window.document.getElementById('root');
  const unmount = await mountApp(container);
  // Visit /about once so its lazy chunk is cached, as on a real return visit,
  // then go home and follow the walkthrough link.
  const homeLink = [...container.querySelectorAll('a')].find(a => a.getAttribute('href') === '/');
  await harness.act(async () => { homeLink.click(); });
  assert.equal(window.location.pathname, '/');

  const link = [...container.querySelectorAll('a')].find(a => a.getAttribute('href') === '/about#how-it-works');
  assert.ok(link, 'Home links to the walkthrough');
  calls.length = 0;
  await harness.act(async () => { link.click(); });
  assert.equal(window.location.pathname, '/about');
  assert.ok(window.document.getElementById('how-it-works'), 'the section is rendered');
  assert.deepEqual(calls.at(-1), ['scrollIntoView', 'how-it-works'], JSON.stringify(calls));

  // A plain route change still starts at the top.
  const docsLink = [...container.querySelectorAll('a')].find(a => a.getAttribute('href') === '/documentation');
  calls.length = 0;
  await harness.act(async () => { docsLink.click(); });
  assert.deepEqual(calls.at(-1), ['scrollTo', [0, 0]], JSON.stringify(calls));

  // Hash-only navigations never scroll to the top (issue #280): following an
  // in-page link, going Back to the bare path, and naming a missing anchor.
  const aboutLink = [...container.querySelectorAll('a')].find(a => a.getAttribute('href') === '/about');
  await harness.act(async () => { aboutLink.click(); });
  assert.equal(window.location.pathname, '/about');
  const popTo = async url => {
    calls.length = 0;
    await harness.act(async () => {
      window.history.pushState(null, '', url);
      window.dispatchEvent(new window.PopStateEvent('popstate', { state: null }));
    });
    return calls.filter(([kind]) => kind === 'scrollTo');
  };
  assert.deepEqual(await popTo('/about#future'), [], JSON.stringify(calls));
  assert.deepEqual(calls.at(-1), ['scrollIntoView', 'future'], JSON.stringify(calls));
  assert.deepEqual(await popTo('/about'), [], JSON.stringify(calls));
  assert.deepEqual(await popTo('/about#does-not-exist'), [], JSON.stringify(calls));
  assert.deepEqual(calls, [], 'a missing anchor scrolls nowhere');
  // A pathname change from a hashed URL still starts at the top.
  assert.deepEqual(await popTo('/documentation'), [['scrollTo', [0, 0]]], JSON.stringify(calls));

  await unmount();
  window.close();
});

// index.html's gtag('config') must not send its own page view: the router
// sends one per pathname (issue #347). Before, config sent one on load and
// the router's gtag('config', ..., { page_path }) another for the same page.
const countsAsPageView = ([command, target, params]) =>
  (command === 'event' && target === 'page_view') ||
  (command === 'config' && params?.send_page_view !== false);

test('index.html config does not send a page view of its own (issue #347)', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const configs = [...html.matchAll(/gtag\('config',([^;]*)\);/g)].map(m => m[1]);
  assert.equal(configs.length, 1, configs.join(' | '));
  assert.match(configs[0], /window\.__GA_ID__,\s*\{\s*send_page_view:\s*false\s*\}/);
});

test('the router sends exactly one GA page view per page, on load and on each navigation (issue #347)', async () => {
  const dom = installDom('https://bsod.windowsforum.com/');
  const { window } = dom;
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = () => {};
  window.__GA_ID__ = 'G-TEST123';
  const calls = [];
  window.gtag = (...args) => { calls.push(args); };

  const container = window.document.getElementById('root');
  const unmount = await mountApp(container);
  const views = () => calls.filter(countsAsPageView);
  assert.equal(views().length, 1, JSON.stringify(calls));
  assert.deepEqual(views()[0].slice(0, 2), ['event', 'page_view']);
  assert.equal(views()[0][2].page_path, '/');
  assert.equal(views()[0][2].send_to, 'G-TEST123', 'uses window.__GA_ID__, not a hard-coded id');

  for (const href of ['/about', '/documentation']) {
    const link = [...container.querySelectorAll('a')].find(a => a.getAttribute('href') === href);
    await harness.act(async () => { link.click(); });
    assert.equal(window.location.pathname, href);
  }
  assert.deepEqual(views().map(([, , params]) => params.page_path), ['/', '/about', '/documentation'], JSON.stringify(calls));

  await unmount();
  window.close();
});

// The SSO redirect fallback lands on /analyzer#wf_sso=<token>&wf_sso_state=..
// and the router's first page view runs before AuthProvider strips the
// fragment: page_location must never carry it to Google (issue #361).
test('GA page views never carry the URL fragment (SSO token) to Google (issue #361)', async () => {
  const dom = installDom('https://bsod.windowsforum.com/analyzer?ref=forum#wf_sso=SECRET-TOKEN&wf_sso_state=0123abcd');
  const { window } = dom;
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = () => {};
  window.__GA_ID__ = 'G-TEST123';
  const calls = [];
  window.gtag = (...args) => { calls.push(args); };

  const container = window.document.getElementById('root');
  const unmount = await mountApp(container);
  const views = calls.filter(countsAsPageView);
  assert.equal(views.length, 1, JSON.stringify(calls));
  assert.equal(views[0][2].page_location, 'https://bsod.windowsforum.com/analyzer?ref=forum');
  // gtag 'set' makes later events and gtag.js's own page URL use the
  // fragment-less location too, before the page view goes out (issue #367).
  const set = calls.findIndex(([command, params]) => command === 'set' && params?.page_location === 'https://bsod.windowsforum.com/analyzer?ref=forum');
  assert.ok(set >= 0, JSON.stringify(calls));
  assert.ok(set < calls.indexOf(views[0]), 'set before the page view');
  const sent = JSON.stringify(calls);
  assert.doesNotMatch(sent, /SECRET-TOKEN|wf_sso|#/, sent);

  await unmount();
  window.close();
});

test('useAnalytics never reads the full URL or its fragment (issue #361)', () => {
  const source = fs.readFileSync(path.join(root, 'hooks/useAnalytics.tsx'), 'utf8')
    .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(source, /location\.href|location\.hash|document\.URL|document\.referrer/);
});

const ROUTES = ['/about','/documentation', '/donate', '/analyzer', '/stats', '/privacy'];
const rendered = new Map();
async function prerender(route) {
  if (!rendered.has(route)) rendered.set(route, await harness.renderAsync(route));
  return rendered.get(route);
}

test('each prerendered page carries one title and one description, branded once (issue #242)', async () => {
  for (const route of ROUTES) {
    const html = await prerender(route);
    const titles = html.match(/<title>[^<]*<\/title>/g) || [];
    assert.equal(titles.length, 1, `${route}: ${titles.join(' ')}`);
    assert.equal((html.match(/<meta name="description"/g) || []).length, 1, `${route}: one description`);
    assert.equal((html.match(/<link rel="canonical"/g) || []).length, 1, `${route}: one canonical`);
    assert.equal(titles[0].split('BSOD AI Analyzer').length - 1, 1, `${route}: brand once in ${titles[0]}`);
  }
});

test('prerendered pages inline their Suspense content instead of outlining it behind the Loader (issue #243)', async () => {
  for (const route of ROUTES) {
    const html = await prerender(route);
    assert.ok(!html.includes('<!--$?-->'), `${route}: no pending Suspense boundary`);
    assert.ok(!html.includes('hidden id="S:'), `${route}: no hidden outlined segment`);
  }
});
