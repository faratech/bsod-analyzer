import test, { after, beforeEach } from 'node:test';
import { createMountTracker, failFileAfter, JSDOM_FILE_TIMEOUT_MS } from './helpers/jsdomCleanup.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rolldown } from 'rolldown';
import { JSDOM } from 'jsdom';

// Renders the real Navigation (React and the router bundled in, one instance)
// into jsdom, laid out like AppRouter: header + mobile menu, then the page's
// <main> and the footer as siblings.
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const file = (...parts) => JSON.stringify(path.join(root, ...parts));
const HARNESS = `
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from ${file('hooks', 'useTheme.tsx')};
import Navigation from ${file('components', 'Navigation.tsx')};

export async function mountNavigation(container) {
  const r = createRoot(container);
  await act(async () => {
    r.render(React.createElement(ThemeProvider, null,
      React.createElement(MemoryRouter, { initialEntries: ['/about'] },
        React.createElement('div', { className: 'app' },
          React.createElement(Navigation),
          React.createElement('main', null, React.createElement('a', { href: '#x' }, 'page link')),
          React.createElement('footer', null, 'footer')))));
  });
  return () => act(() => r.unmount());
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

let dom;
function installDom() {
  dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>', { url: 'https://bsod.windowsforum.com/about' });
  // A phone-width viewport: the desktop-nav media query never matches.
  dom.window.matchMedia = query => ({
    matches: false, media: query, addEventListener() {}, removeEventListener() {},
  });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent', 'localStorage']) {
    Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : dom.window[key], configurable: true, writable: true });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}
beforeEach(installDom);

const harness = await loadHarness();

// Unmount every root even when an assertion fails, so the component's timers
// cannot keep this file alive (issue #321).
failFileAfter(JSDOM_FILE_TIMEOUT_MS, 'mobileNavigation.test.mjs');
const track = createMountTracker();
const mountNavigation = async (...args) => track(await harness.mountNavigation(...args));
const $ = selector => dom.window.document.querySelector(selector);

async function openMenu() {
  await harness.act(async () => { $('.mobile-menu-toggle').click(); });
  assert.ok($('.mobile-nav').classList.contains('open'), 'the menu opened');
}

test('opening the mobile menu moves focus into it and makes the page behind it inert (issue #295)', async () => {
  const unmount = await mountNavigation($('#root'));
  const toggle = $('.mobile-menu-toggle');
  assert.equal(toggle.getAttribute('aria-controls'), $('.mobile-nav').id, 'the toggle names the menu it controls');
  assert.ok($('.mobile-nav').id);
  await openMenu();
  assert.ok($('.mobile-nav').contains(dom.window.document.activeElement), 'focus is inside the menu');
  assert.ok($('main').hasAttribute('inert'), '<main> is inert');
  assert.ok($('footer').hasAttribute('inert'), 'the footer is inert');
  assert.equal($('header').hasAttribute('inert'), false, 'the header (with the close toggle) stays reachable');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.match(toggle.getAttribute('aria-label'), /close/i, 'the toggle is labelled as the close control');
  await unmount();
});

test('Escape closes the mobile menu and returns focus to the toggle (issue #295)', async () => {
  const unmount = await mountNavigation($('#root'));
  await openMenu();
  await harness.act(async () => {
    dom.window.document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  assert.equal($('.mobile-nav').classList.contains('open'), false, 'the menu closed');
  assert.equal(dom.window.document.activeElement, $('.mobile-menu-toggle'), 'focus is back on the toggle');
  assert.equal($('main').hasAttribute('inert'), false);
  assert.equal($('footer').hasAttribute('inert'), false);
  await unmount();
});

test('the toggle closes an open menu (issue #295)', async () => {
  const unmount = await mountNavigation($('#root'));
  await openMenu();
  await harness.act(async () => { $('.mobile-menu-toggle').click(); });
  assert.equal($('.mobile-nav').classList.contains('open'), false);
  assert.equal($('main').hasAttribute('inert'), false);
  await unmount();
});

// The overlay is position: fixed over the whole viewport, and the header is a
// sticky stacking context; the toggle is only clickable when the header paints
// above the overlay while the menu is open.
function zIndexOf(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(rule, `styles.css has a ${selector} rule`);
  const z = rule[1].match(/z-index:\s*(\d+)/);
  assert.ok(z, `${selector} sets a z-index`);
  return Number(z[1]);
}
test('the header (holding the toggle) stacks above the open mobile menu overlay (issue #295)', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.ok(zIndexOf(css, 'body.mobile-menu-open .header') > zIndexOf(css, '.mobile-nav'));
});

test('the mobile menu offers a theme toggle, since the desktop nav is hidden at <= 1024 px (issue #296)', async () => {
  const unmount = await mountNavigation($('#root'));
  await openMenu();
  const toggles = [...dom.window.document.querySelectorAll('.theme-toggle')].filter(el => !el.closest('.desktop-nav'));
  assert.equal(toggles.length, 1, 'one theme toggle outside the desktop nav');
  assert.ok(toggles[0].closest('.mobile-nav'), 'it is in the mobile menu');
  const before = dom.window.document.documentElement.className;
  await harness.act(async () => { toggles[0].click(); });
  assert.notEqual(dom.window.document.documentElement.className, before, 'it switches the theme');
  assert.ok($('.mobile-nav').classList.contains('open'), 'switching the theme keeps the menu open');
  await unmount();
});
