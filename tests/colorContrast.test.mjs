import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

// Token blocks: `:root, .dark { ... }` and `.light { ... }`, in styles.css and in
// the critical CSS inlined in index.html (the first paint uses the latter).
function tokens(source, selectorPattern) {
  const match = source.match(new RegExp(`${selectorPattern}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `token block ${selectorPattern}`);
  return Object.fromEntries([...match[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
}
const SOURCES = {
  'styles.css': read('styles.css'),
  'index.html': read('index.html'),
};
const THEMES = {
  dark: ':root,\\s*\\.dark',
  light: '\\.light',
};

function luminance(hex) {
  assert.match(hex, /^#[0-9a-f]{6}$/i, `${hex} is a plain hex colour`);
  const [r, g, b] = [1, 3, 5].map(i => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const BACKGROUNDS = ['--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-hover'];

test('--text-tertiary reaches 4.5:1 on every background in both themes and both stylesheets (issue #298)', () => {
  for (const [name, source] of Object.entries(SOURCES)) {
    for (const [theme, selector] of Object.entries(THEMES)) {
      const t = tokens(source, selector);
      for (const bg of BACKGROUNDS) {
        if (!t[bg]) continue; // index.html declares all four, styles.css too
        const ratio = contrast(t['--text-tertiary'], t[bg]);
        assert.ok(ratio >= 4.5, `${name} ${theme}: --text-tertiary ${t['--text-tertiary']} on ${bg} ${t[bg]} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
});

test('--status-warning text reaches 4.5:1 on the card backgrounds in both themes (issue #298)', () => {
  for (const [name, source] of Object.entries(SOURCES)) {
    for (const [theme, selector] of Object.entries(THEMES)) {
      const t = tokens(source, selector);
      for (const bg of ['--bg-primary', '--bg-secondary', '--bg-tertiary']) {
        const ratio = contrast(t['--status-warning'], t[bg]);
        assert.ok(ratio >= 4.5, `${name} ${theme}: --status-warning ${t['--status-warning']} on ${bg} ${t[bg]} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
});

test('the critical CSS in index.html declares the same colour tokens as styles.css (issue #298)', () => {
  for (const [theme, selector] of Object.entries(THEMES)) {
    const full = tokens(SOURCES['styles.css'], selector);
    const critical = tokens(SOURCES['index.html'], selector);
    for (const [name, value] of Object.entries(critical)) {
      assert.equal(value, full[name], `${theme} ${name}`);
    }
  }
});

test('warning text uses the themed token, not a literal amber (issue #298)', () => {
  for (const f of ['AnalysisReportCard.tsx', 'AnalysisProgress.tsx']) {
    assert.ok(!/#f59e0b/i.test(read('components', f)), `${f} hard-codes the dark-theme amber`);
  }
  assert.doesNotMatch(read('pages', 'Analyzer.tsx'), /opacity:\s*0\.3[^]{0,80}text-tertiary|text-tertiary[^]{0,80}opacity:\s*0\.3/,
    'the build-version footer must not dim tertiary text further');
});

// Alpha tint `rgba(r, g, b, a)` composited over an opaque hex background.
function over(tint, backgroundHex) {
  const [r, g, b, a] = tint;
  const bg = [1, 3, 5].map(i => parseInt(backgroundHex.slice(i, i + 2), 16));
  return '#' + [r, g, b].map((c, i) => Math.round(c * a + bg[i] * (1 - a)).toString(16).padStart(2, '0')).join('');
}
const CARD_BACKGROUNDS = ['--bg-primary', '--bg-secondary', '--bg-tertiary'];

test('--status-success text reaches 4.5:1 on the backgrounds and green fills it is drawn on (issue #312)', () => {
  for (const [name, source] of Object.entries(SOURCES)) {
    for (const [theme, selector] of Object.entries(THEMES)) {
      const t = tokens(source, selector);
      const fg = t['--status-success'];
      // "Security check completed" (FileUploader) sits on the plain card backgrounds.
      for (const bg of BACKGROUNDS) {
        if (!t[bg]) continue;
        const ratio = contrast(fg, t[bg]);
        assert.ok(ratio >= 4.5, `${name} ${theme}: --status-success ${fg} on ${bg} ${t[bg]} is ${ratio.toFixed(2)}:1`);
      }
      for (const bg of CARD_BACKGROUNDS) {
        // .status-completed: rgba(16, 185, 129, 0.1).
        const fill = over([16, 185, 129, 0.1], t[bg]);
        const ratio = contrast(fg, fill);
        assert.ok(ratio >= 4.5, `${name} ${theme}: --status-success ${fg} on green 0.1 over ${bg} is ${ratio.toFixed(2)}:1`);
      }
      if (/^#[0-9a-f]{6}$/i.test(t['--status-success-bg'] || '')) {
        const ratio = contrast(fg, t['--status-success-bg']);
        assert.ok(ratio >= 4.5, `${name} ${theme}: --status-success on --status-success-bg is ${ratio.toFixed(2)}:1`);
      }
    }
  }
});

test('--status-warning text reaches 4.5:1 on the amber fills it is drawn on (issue #312)', () => {
  // .status-pending 0.1, .confidence-fallback 0.12, the progress fallback
  // notice (AnalysisProgress) 0.15, .status-warning 0.2.
  for (const [name, source] of Object.entries(SOURCES)) {
    for (const [theme, selector] of Object.entries(THEMES)) {
      const t = tokens(source, selector);
      for (const alpha of [0.1, 0.12, 0.15, 0.2]) {
        for (const bg of CARD_BACKGROUNDS) {
          const fill = over([245, 158, 11, alpha], t[bg]);
          const ratio = contrast(t['--status-warning'], fill);
          assert.ok(ratio >= 4.5, `${name} ${theme}: --status-warning ${t['--status-warning']} on amber ${alpha} over ${bg} ${t[bg]} is ${ratio.toFixed(2)}:1`);
        }
      }
    }
  }
  assert.match(read('components', 'AnalysisProgress.tsx'), /rgba\(245, 158, 11, 0\.15\)[^]{0,500}color: 'var\(--status-warning\)'/);
});

// Text drawn on a --status-* background (issue #324): every styles.css rule
// and every inline style object in components/ and pages/ that paints a
// background from a --status-* token, checked against the foreground that
// actually applies there: its own `color`, the colour its base rule sets
// (`.progress-stage-dot` for `.progress-stage-dot.completed`), the colours of
// styled descendants (inline styles), or the inherited --text-primary.
const NAMED_COLOURS = { white: '#ffffff', black: '#000000' };
// Background-only marks with no text in them.
const DECORATIVE_STATUS_FILLS = new Set(['.progress-stage-line.completed']);
const OWN_COLOUR = /(?<![\w-])color\s*:\s*([^;,\n}]+)/;

function colourRefs(expression) {
  const refs = [...expression.matchAll(/var\((--[\w-]+)\)/g)].map(m => m[1]);
  for (const m of expression.matchAll(/'(#[0-9a-f]{3,6}|white|black)'|(?<![\w-])(#[0-9a-f]{6}|white|black)\b/gi)) refs.push((m[1] || m[2]).toLowerCase());
  return refs;
}
function resolveColour(ref, t) {
  let value = ref.startsWith('--') ? t[ref] : ref;
  assert.ok(value, `colour ${ref} resolves`);
  value = NAMED_COLOURS[value] || value;
  if (/^#[0-9a-f]{3}$/i.test(value)) value = '#' + [...value.slice(1)].map(c => c + c).join('');
  return value.toLowerCase();
}
// A background token as the opaque colours it can composite to.
function surfaces(ref, t) {
  const value = t[ref];
  assert.ok(value, `background ${ref} resolves`);
  const rgba = value.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/);
  return rgba ? CARD_BACKGROUNDS.map(bg => over(rgba.slice(1).map(Number), t[bg])) : [resolveColour(ref, t)];
}
function isLargeText(styleText) {
  const size = Number(styleText.match(/fontSize:\s*'([\d.]+)rem'/)?.[1] ?? 1);
  const bold = /fontWeight:\s*'(bold|[7-9]00)'/.test(styleText);
  return size >= 1.5 || (bold && size >= 1.1667);
}

function cssStatusFills(source) {
  const rules = [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ selector: m[1].trim(), body: m[2] }));
  const colourOf = selector => rules.find(r => r.selector.split(',').map(s => s.trim()).includes(selector) && OWN_COLOUR.test(r.body))?.body.match(OWN_COLOUR)[1];
  const fills = [];
  for (const rule of rules) {
    const bg = rule.body.match(/(?<![\w-])background(?:-color)?\s*:\s*var\((--status-[\w-]+)\)/);
    if (!bg) continue;
    for (const selector of rule.selector.split(',').map(s => s.trim())) {
      if (DECORATIVE_STATUS_FILLS.has(selector)) continue;
      const base = selector.replace(/(\.[\w-]+|:[\w-]+)+$/, m => m.match(/^\.[\w-]+/)?.[0] ?? '');
      const own = rule.body.match(OWN_COLOUR)?.[1] ?? colourOf(selector) ?? (base !== selector ? colourOf(base) : undefined);
      fills.push({ where: selector, background: bg[1], foregrounds: [{ refs: own ? colourRefs(own) : ['--text-primary'], large: false }] });
    }
  }
  return fills;
}

function tsxStatusFills(file, source) {
  const fills = [];
  for (const m of source.matchAll(/(?<![\w-])background(?:Color)?:\s*'var\((--status-[\w-]+)\)'/g)) {
    const open = source.lastIndexOf('style={{', m.index);
    const close = source.indexOf('}}', m.index);
    const style = source.slice(open, close);
    const tagStart = source.lastIndexOf('<', open);
    const tag = source.slice(tagStart + 1).match(/^[\w.]+/)[0];
    // The element's extent: same-tag opens and closes until it is balanced.
    let depth = 0;
    let end = tagStart;
    const tagPattern = new RegExp(`<(/?)${tag}(?=[\\s>])`, 'g');
    tagPattern.lastIndex = tagStart;
    for (let t; (t = tagPattern.exec(source));) {
      depth += t[1] ? -1 : 1;
      end = t.index;
      if (depth === 0) break;
    }
    const foregrounds = [];
    const own = style.match(OWN_COLOUR)?.[1];
    foregrounds.push({ refs: own ? colourRefs(own) : ['--text-primary'], large: own ? isLargeText(style) : false });
    for (const child of source.slice(close, end).matchAll(/style=\{\{([^]*?)\}\}/g)) {
      const childColour = child[1].match(OWN_COLOUR)?.[1];
      if (childColour) foregrounds.push({ refs: colourRefs(childColour), large: isLargeText(child[1]) });
    }
    const line = source.slice(0, m.index).split('\n').length;
    fills.push({ where: `${file}:${line}`, background: m[1], foregrounds });
  }
  return fills;
}

function tsxSources() {
  const out = [];
  for (const dir of ['components', 'pages']) {
    for (const f of fs.readdirSync(path.join(root, dir))) {
      if (f.endsWith('.tsx')) out.push([`${dir}/${f}`, read(dir, f)]);
    }
  }
  return out;
}

test('text drawn on a --status-* background reaches 4.5:1 (3:1 for large text) in both themes (issue #324)', () => {
  const t = Object.fromEntries(Object.entries(THEMES).map(([theme, selector]) => [theme, tokens(SOURCES['styles.css'], selector)]));
  const fills = [
    ...cssStatusFills(SOURCES['styles.css']).map(f => ({ ...f, where: `styles.css ${f.where}` })),
    ...cssStatusFills(SOURCES['index.html']).map(f => ({ ...f, where: `index.html ${f.where}` })),
    ...tsxSources().flatMap(([file, source]) => tsxStatusFills(file, source))
  ];
  const where = fills.map(f => f.where).join('\n');
  // The scan must keep finding the fills it was written for.
  assert.match(where, /styles\.css \.progress-stage-dot\.completed/);
  assert.match(where, /styles\.css \.confidence-windbg/);
  assert.equal(fills.filter(f => f.where.startsWith('components/AnalysisReportCard.tsx')).length, 4, where);

  const failures = [];
  for (const fill of fills) {
    for (const [theme, tk] of Object.entries(t)) {
      for (const surface of surfaces(fill.background, tk)) {
        for (const fg of fill.foregrounds) {
          for (const ref of fg.refs) {
            const colour = resolveColour(ref, tk);
            const ratio = contrast(colour, surface);
            const min = fg.large ? 3 : 4.5;
            if (ratio < min) failures.push(`${fill.where} ${theme}: ${ref} ${colour} on ${fill.background} (${surface}) is ${ratio.toFixed(2)}:1 < ${min}`);
          }
        }
      }
    }
  }
  assert.deepEqual(failures, []);
});
