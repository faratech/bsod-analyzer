import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// bigquery/*.sql never runs in CI (BigQuery scheduled queries are
// operator-owned), so these tests evaluate the relevant SQL in JS.
const routines = fs.readFileSync(new URL('../bigquery/routines.sql', import.meta.url), 'utf8');

// Turns the windows_release() CASE into a JS function. Supports exactly the
// condition forms the function uses, and throws on anything else so a new
// form cannot slip past the test.
function compileWindowsRelease(sql) {
  const body = sql.match(/FUNCTION `[^`]*\.windows_release`\(build INT64, product STRING\) AS \(\s*CASE([\s\S]*?)\n\s*END\s*\n\);/);
  assert.ok(body, 'windows_release CASE found');
  const arms = [];
  let fallback;
  for (const raw of body[1].split('\n')) {
    const line = raw.replace(/--.*$/, '').trim();
    if (!line) continue;
    const elseArm = line.match(/^ELSE '([^']*)'$/);
    if (elseArm) { fallback = elseArm[1]; continue; }
    const arm = line.match(/^WHEN (.+) THEN '([^']*)'$/);
    assert.ok(arm, `unsupported CASE line: ${line}`);
    const conds = arm[1].split(/ AND /);
    const preds = [];
    for (let i = 0; i < conds.length; i++) {
      const c = conds[i].trim();
      let m;
      if (c === 'build IS NULL') preds.push((b) => b == null);
      else if ((m = c.match(/^product = '([^']*)'$/))) { const v = m[1]; preds.push((b, p) => p === v); }
      else if ((m = c.match(/^build (=|>|>=|<|<=) (\d+)$/))) {
        const [op, n] = [m[1], Number(m[2])];
        preds.push((b) => b != null && ({ '=': b === n, '>': b > n, '>=': b >= n, '<': b < n, '<=': b <= n })[op]);
      } else if ((m = c.match(/^build IN \(([\d, ]+)\)$/))) {
        const set = new Set(m[1].split(',').map(Number)); preds.push((b) => set.has(b));
      } else if ((m = c.match(/^build BETWEEN (\d+)$/)) && /^\d+$/.test(conds[i + 1]?.trim() ?? '')) {
        const lo = Number(m[1]); const hi = Number(conds[++i].trim()); preds.push((b) => b != null && b >= lo && b <= hi);
      } else if ((m = c.match(/^build NOT IN \(([\d, ]+)\)$/))) {
        const set = new Set(m[1].split(',').map(Number)); preds.push((b) => b != null && !set.has(b));
      } else assert.fail(`unsupported condition: ${c}`);
    }
    arms.push([preds, arm[2]]);
  }
  return (build, product) => {
    for (const [preds, label] of arms) if (preds.every(p => p(build, product))) return label;
    return fallback;
  };
}

test('windows_release labels GA 26H2/26H1 by name, not Insider (issue #372)', () => {
  const release = compileWindowsRelease(routines);
  const cases = [
    [28000, 'Workstation', 'Windows 11 26H1'],
    [26300, 'Workstation', 'Windows 11 26H2'],
    [26200, 'Workstation', 'Windows 11 25H2'],
    [26100, 'Workstation', 'Windows 11 24H2'],
    [22631, 'Workstation', 'Windows 11 22H2/23H2'],
    [22000, 'Workstation', 'Windows 11 21H2'],
    [19045, 'Workstation', 'Windows 10 20H1-22H2'],
    [26220, 'Workstation', 'Windows 11 Insider'],
    [27900, 'Workstation', 'Windows 11 Insider'],
    [29100, 'Workstation', 'Windows 11 Insider'],
    [28000, null, 'Windows 11 26H1'],
    [26100, 'Server', 'Windows Server 2025'],
    [20348, 'Server', 'Windows Server 2022'],
    [null, 'Workstation', 'Unknown'],
  ];
  for (const [build, product, expected] of cases) {
    assert.equal(release(build, product), expected, `${build}/${product}`);
  }
});

test('routines.sql tells the operator to rebuild job_facts after changing it (issue #372)', () => {
  const header = routines.split('\n').filter(l => l.startsWith('--')).slice(0, 20).join('\n');
  assert.match(header, /job_facts_full\.sql/);
});

// --- crash_utc_weekday / crash_utc_hour (issue #373) -----------------------

// Splits a SELECT list on top-level commas (outside parentheses and quotes),
// after dropping -- comments.
function splitSelectList(list) {
  const items = [];
  let depth = 0, quote = null, cur = '';
  for (const ch of list.replace(/--[^\n]*/g, '')) {
    if (quote) { if (ch === quote) quote = null; }
    else if (ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) { items.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) items.push(cur.trim());
  return Object.fromEntries(items.map(item => {
    const m = item.match(/^([\s\S]+?)\s+AS\s+(\w+)$/);
    return m ? [m[2], m[1]] : [item, item];
  }));
}

// Translates the handful of BigQuery functions these columns use into JS.
// NULL is modelled as null and propagates like SQL NULL.
const SQL_RUNTIME = {
  RX: (s, re) => { if (s == null) return undefined; const m = new RegExp(re).exec(s); return m ? m[1] : undefined; },
  CAST: (x) => { if (x == null) return undefined; const n = Number(String(x).trim()); return Number.isInteger(n) ? n : undefined; },
  REPLACE: (s, a, b) => (s == null ? undefined : s.split(a).join(b)),
  SUBSTR: (s, start, len) => (s == null ? undefined : s.substr(start - 1, len)),
  STRPOS: (s, sub) => (s == null || sub == null ? undefined : s.indexOf(sub) + 1),
  NULLIF: (a, b) => (a === b ? undefined : a),
  IFF: (c, a, b) => (c ? a : b),
  EQ: (a, b) => (a == null || b == null ? undefined : a === b),
  MOD: (a, b) => (a == null || b == null ? undefined : a % b),
  DIV: (a, b) => (a == null || b == null ? undefined : Math.trunc(a / b)),
};

function sqlToJs(expr) {
  let js = expr
    .replace(/REGEXP_EXTRACT\(\s*w\.session_time,\s*r'([^']*)'\)/g, (_, re) => `RX(S, String.raw\`${re}\`)`)
    .replace(/SAFE_CAST\(/g, 'CAST(').replace(/\s+AS INT64\)/g, ')')
    .replace(/\bIF\(/g, 'IFF(')
    .replace(/w\.session_time/g, 'S')
    .replace(/\bf\./g, 'v.');
  // a = 'x' -> EQ(a, 'x') for the simple operand forms used here
  js = js.replace(/(RX\(S, String\.raw`[^`]*`\)) = ('[^']*')/g, 'EQ($1, $2)');
  if (/\b(CASE|REGEXP_CONTAINS|LOWER|TIMESTAMP)\b/.test(js)) return null;
  return js;
}

function compileUtcColumns(sql) {
  const fn = sql.match(/TABLE FUNCTION `[^`]*\.job_facts_since`[\s\S]*?\n\);/)[0];
  const fList = fn.match(/f AS \(\s*SELECT\s+w\.\*,([\s\S]*?)\n\s*FROM w\b/)[1];
  const outList = fn.match(/\)\s*SELECT([\s\S]*?)\n\s*FROM f\b/)[1];
  const fItems = splitSelectList(fList);
  const outItems = splitSelectList(outList);
  const locals = Object.entries(fItems).filter(([name]) => /^(local_|utc_offset)/.test(name));
  const body = [
    'const v = {};',
    ...locals.map(([name, expr]) => `v.${name} = (${sqlToJs(expr)});`),
    `const weekday = (${sqlToJs(outItems.crash_utc_weekday)});`,
    `const hour = (${sqlToJs(outItems.crash_utc_hour)});`,
    'return { weekday, hour };',
  ].join('\n');
  const run = new Function(...Object.keys(SQL_RUNTIME), 'S', body);
  return (sessionTime) => {
    const { weekday, hour } = run(...Object.values(SQL_RUNTIME), sessionTime);
    const norm = (x) => (x == null || Number.isNaN(x) ? null : x);
    return { weekday: norm(weekday), hour: norm(hour) };
  };
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// Reference: local wall time minus the offset, via Date in UTC. 2026-10-12 is a Monday.
function reference(dayIndex, hh, mm, offsetMinutes) {
  const t = Date.UTC(2026, 9, 12 + dayIndex, hh, mm) - offsetMinutes * 60000;
  const d = new Date(t);
  return { weekday: (d.getUTCDay() + 6) % 7, hour: d.getUTCHours() };
}
function sessionTime(dayIndex, hh, mm, offsetMinutes) {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `${DAYS[dayIndex]} Oct ${12 + dayIndex} ${hh}:${String(mm).padStart(2, '0')}:33.123 2026 (UTC ${sign} ${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')})`;
}

test('crash_utc_weekday/hour honour the minutes of half-hour offsets (issue #373)', () => {
  const utc = compileUtcColumns(routines);
  // Examples from the issue.
  assert.deepEqual(utc('Mon Oct 12 10:20:33.123 2026 (UTC + 5:30)'), { weekday: 0, hour: 4 });
  assert.deepEqual(utc('Mon Oct 12 0:10:33.123 2026 (UTC + 5:45)'), { weekday: 6, hour: 18 });
  assert.deepEqual(utc('Mon Oct 12 23:40:33.123 2026 (UTC - 3:30)'), { weekday: 1, hour: 3 });
  const offsets = [0, 60, -60, 330, 345, 570, 630, 210, -210, -570, 840, -720, 525];
  const times = [[0, 0], [0, 10], [0, 59], [4, 45], [10, 20], [12, 30], [23, 0], [23, 40], [23, 59]];
  for (const offset of offsets) {
    for (let day = 0; day < 7; day++) {
      for (const [hh, mm] of times) {
        const st = sessionTime(day, hh, mm, offset);
        assert.deepEqual(utc(st), reference(day, hh, mm, offset), st);
      }
    }
  }
});

test('crash_utc columns stay NULL for unparseable session times (issue #373)', () => {
  const utc = compileUtcColumns(routines);
  assert.deepEqual(utc(null), { weekday: null, hour: null });
  assert.equal(utc('Xyz Oct 12 10:20:33.123 2026 (UTC + 5:30)').weekday, null);
  assert.deepEqual(utc('Mon Oct 12 10:20:33.123 2026'), { weekday: null, hour: null });
});

// --- cpu_threads histogram (issue #374) ------------------------------------

test('cpu_threads bins hold only the counts their labels name (issue #374)', () => {
  const insights = fs.readFileSync(new URL('../bigquery/crash_insights.sql', import.meta.url), 'utf8');
  const block = insights.match(/ARRAY\(SELECT AS STRUCT k, COUNT\(\*\) AS n, MIN\(o\) AS o FROM \(([\s\S]*?)\) GROUP BY k ORDER BY o\) AS cpu_threads/);
  assert.ok(block, 'cpu_threads block found');
  const [labelCase, orderCase] = block[1].match(/CASE[\s\S]*?END/g);
  const compile = (expr) => {
    const arms = [...expr.matchAll(/WHEN processor_count <= (\d+) THEN ('[^']*'|\d+)/g)]
      .map(([, max, v]) => [Number(max), v.replace(/'/g, '')]);
    const otherwise = expr.match(/ELSE ('[^']*'|\d+) END/)[1].replace(/'/g, '');
    return (n) => (arms.find(([max]) => n <= max) ?? [, otherwise])[1];
  };
  const label = compile(labelCase);
  const order = compile(orderCase);
  const where = block[1].match(/WHERE ([^\n]*)$/m)[1];
  assert.match(where, /processor_count > 0/, 'non-positive counts are excluded');
  let lastOrder = 0;
  for (let n = 1; n <= 40; n++) {
    const k = label(n);
    const range = k.match(/^(\d+)-(\d+)$/);
    if (range) assert.ok(n >= Number(range[1]) && n <= Number(range[2]), `${n} in '${k}'`);
    else assert.ok(k.endsWith('+') && n >= Number.parseInt(k, 10), `${n} in '${k}'`);
    assert.ok(Number(order(n)) >= lastOrder, `order key monotonic at ${n}`);
    lastOrder = Number(order(n));
  }
  assert.equal(label(1), '1-4');
  assert.equal(label(33), '33+');
});
