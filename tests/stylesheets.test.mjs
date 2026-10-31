import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

function styled(css, body) {
  return new JSDOM(`<!DOCTYPE html><html><head><style>${css}</style></head><body>${body}</body></html>`).window;
}

test('an empty ad container stays displayed so the size-checked ads can measure it (issue #240)', () => {
  // DisplayAdSafe / SafeAd render their <ins> only after the container has
  // width; a display:none container never gets any.
  const window = styled(read('styles', 'adsense-fix.css'), '<main class="page-content"><div class="ad-container"></div></main>');
  const container = window.document.querySelector('.ad-container');
  assert.equal(window.getComputedStyle(container).display, 'block');

  const hidden = styled(read('styles', 'adsense-fix.css'), '<div hidden><div class="ad-container"></div></div>');
  assert.equal(hidden.getComputedStyle(hidden.document.querySelector('.ad-container')).display, 'none',
    'slots inside hidden ancestors stay hidden');
});

test('purge-css keeps the classes the app builds dynamically or applies outside components/ (issue #241)', async () => {
  const { PurgeCSS } = await import('purgecss');
  const { purgeOptions } = await import('../scripts/purge-css.js');
  const [result] = await new PurgeCSS().purge(purgeOptions);
  const live = [
    '.confidence-windbg', '.confidence-fallback', '.confidence-mixed',
    '.related-match-both', '.related-match-module',
    ...[0, 1, 2, 3, 4, 5].map(n => `.heatmap-cell.step-${n}`),
    '.gr-jug1', '.gr-jug3', '.gr-z1', '.gr-z3',
    '.app-embed',
  ];
  const purged = live.filter(selector => result.rejected.includes(selector));
  assert.deepEqual(purged, [], 'live selectors would be deleted by --apply');
});

function cssRules(css) {
  const window = styled(css, '');
  return [...window.document.styleSheets[0].cssRules];
}

test('the upload area shows keyboard focus on its visually hidden file input (issue #251)', () => {
  const rules = cssRules(read('styles.css'));
  const focus = rules.filter(rule => rule.selectorText?.split(',').some(s => s.trim() === '.upload-area:focus-within'));
  assert.ok(focus.some(rule => rule.style.outline || rule.style.getPropertyValue('outline-style')), 'outline on .upload-area:focus-within');

  // Behaviour: with the input focused the area computes a visible outline.
  const window = styled(read('styles.css'), '<div class="upload-area"><input type="file" id="file-upload"><label for="file-upload">Drop</label></div>');
  window.document.getElementById('file-upload').focus();
  const area = window.document.querySelector('.upload-area');
  assert.ok(area.matches(':focus-within'));
  assert.match(window.getComputedStyle(area).outline || window.getComputedStyle(area).outlineStyle, /solid/);
});

test('reduced motion stops every looping animation (issue #251)', () => {
  const rules = cssRules(read('styles.css'));
  const looping = rules.filter(rule => rule.style && /infinite/.test(rule.style.animation || rule.style.getPropertyValue('animation-iteration-count')));
  assert.ok(looping.length > 10, `found ${looping.length} looping animations`);

  const reduce = rules.filter(rule => rule.media && /prefers-reduced-motion:\s*reduce/.test(rule.media.mediaText));
  const global = reduce.flatMap(media => [...media.cssRules])
    .find(rule => rule.selectorText?.split(',').map(s => s.trim()).includes('*'));
  assert.ok(global, 'a global prefers-reduced-motion rule covers every element');
  assert.equal(global.style.getPropertyValue('animation-iteration-count'), '1');
  assert.equal(global.style.getPropertyPriority('animation-iteration-count'), 'important');
  assert.ok(parseFloat(global.style.getPropertyValue('animation-duration')) < 1, 'animations end at once');
  assert.equal(global.style.getPropertyPriority('animation-duration'), 'important');
  assert.ok(parseFloat(global.style.getPropertyValue('transition-duration')) < 1, 'transitions end at once');
  // It must come after the looping rules so it wins at equal importance.
  assert.ok(rules.indexOf(reduce.at(-1)) > rules.indexOf(looping.at(-1)));
});

test('the report card header lets a long filename wrap and keeps the expand button on the card (issue #299)', () => {
  const rules = cssRules(read('styles.css'));
  const decls = selector => {
    const found = rules.filter(rule => rule.selectorText?.split(',').some(s => s.trim() === selector));
    assert.ok(found.length > 0, `${selector} rule`);
    return Object.fromEntries(found.flatMap(rule => [...rule.style].map(name => [name, rule.style.getPropertyValue(name).trim()])));
  };
  const filename = decls('.result-filename');
  assert.equal(filename['overflow-wrap'], 'anywhere');
  assert.match(filename['min-width'], /^0(px)?$/);
  const group = decls('.result-header-main');
  assert.match(group['min-width'], /^0(px)?$/);
  assert.match(group.flex, /^1 1 auto$/);
  assert.match(decls('.result-toggle')['flex-shrink'], /^0$/);
});

// The mobile sticky ad bar (issue #369). styles/adsense-fix.css loads after
// styles.css, so both sheets are cascaded in that order.
function stickyBar(status) {
  const css = read('styles.css') + '\n' + read('styles', 'adsense-fix.css');
  const ins = status ? `<ins class="adsbygoogle" data-ad-status="${status}"></ins>` : '<ins class="adsbygoogle"></ins>';
  const window = styled(css, `<div class="mobile-only"><div class="ad-container sticky-ad">${ins}</div></div>`);
  return { window, bar: window.getComputedStyle(window.document.querySelector('.sticky-ad')) };
}

test('a filled sticky ad bar uses the theme background, never a fixed white (issue #369)', () => {
  const { bar } = stickyBar('filled');
  assert.equal(bar.backgroundColor, 'var(--bg-primary)');
  assert.equal(bar.pointerEvents, 'auto');
  assert.equal(bar.position, 'fixed');
  // Flush with the bottom edge, so the page padding equals what it covers.
  assert.equal(bar.bottom, '0px');
  assert.equal(bar.marginBottom, '0px');
});

test('an unfilled, pending or blocked sticky ad bar is invisible and lets taps through but keeps its layout (issue #369)', () => {
  for (const status of [undefined, 'unfilled']) {
    const { bar } = stickyBar(status);
    assert.equal(bar.backgroundColor, 'rgba(0, 0, 0, 0)', `status ${status}`);
    assert.equal(bar.boxShadow, 'none', `status ${status}`);
    assert.equal(bar.pointerEvents, 'none', `status ${status}`);
    // Still laid out: SafeAd only inserts its <ins> into a container with
    // width, so display:none would keep the slot from ever loading (#240).
    assert.equal(bar.display, 'block', `status ${status}`);
    assert.equal(bar.position, 'fixed', `status ${status}`);
  }
});

test('the page reserves room for the sticky ad bar on mobile only while it is filled (issue #369)', () => {
  const rules = cssRules(read('styles.css'));
  const media = rules.filter(rule => rule.media && [...rule.cssRules].some(inner => inner.selectorText?.includes('.sticky-ad')));
  const padding = media.flatMap(rule => [...rule.cssRules]).find(inner => inner.selectorText?.startsWith('body:has('));
  assert.ok(padding, 'a body:has(...) rule inside a media query');
  assert.match(padding.selectorText, /\.sticky-ad ins\[data-ad-status="filled"\]/);
  assert.equal(padding.style.paddingBottom, 'var(--sticky-ad-height)');
  const bar = rules.find(rule => rule.selectorText === '.ad-container.sticky-ad');
  assert.equal(bar.style.maxHeight, 'var(--sticky-ad-height)');
  assert.equal(bar.style.boxSizing, 'border-box');
});

// Issue #378: the bar was 100px tall including 0.5rem padding top and bottom,
// so a filled 100px unit was clipped by 8px (.ad-container hides overflow).
test('the sticky ad bar is tall enough for its capped ad unit plus its padding (issue #378)', () => {
  const rules = cssRules(read('styles.css'));
  const rootRule = rules.find(rule => rule.selectorText === ':root' && rule.style.getPropertyValue('--sticky-ad-height'));
  const bar = rules.find(rule => rule.selectorText === '.ad-container.sticky-ad');
  const unit = rules.find(rule => rule.selectorText === '.sticky-ad .adsbygoogle');
  const px = value => {
    const m = /^(\d+(?:\.\d+)?)(px|rem)$/.exec(value.trim());
    assert.ok(m, `a px or rem length: ${value}`);
    return m[2] === 'rem' ? Number(m[1]) * 16 : Number(m[1]);
  };
  // Bar height = unit height + vertical padding, written as calc(<unit> + <padding>).
  const height = /^calc\((\S+) \+ (\S+)\)$/.exec(rootRule.style.getPropertyValue('--sticky-ad-height').trim());
  assert.ok(height, rootRule.style.getPropertyValue('--sticky-ad-height'));
  const [unitHeight, verticalPadding] = [px(height[1]), px(height[2])];
  assert.equal(unitHeight, 100, 'the tallest mobile unit');
  assert.equal(px(bar.style.paddingTop || bar.style.padding) + px(bar.style.paddingBottom || bar.style.padding), verticalPadding);
  assert.equal(bar.style.boxSizing, 'border-box');
  assert.equal(bar.style.maxHeight, 'var(--sticky-ad-height)');
  // The unit is capped at the bar's content box, never more.
  assert.equal(unit.style.maxHeight, `calc(var(--sticky-ad-height) - ${height[2]})`);
});
