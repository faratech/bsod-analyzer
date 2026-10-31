import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { rolldown } from 'rolldown';

// The mascot's data and rules (utils/mascotActs.ts, mascotPicks.ts, mascotReaction.ts) bundled for node.
async function load(file) {
  const bundle = await rolldown({ input: new URL(`../utils/${file}`, import.meta.url).pathname, platform: 'node', logLevel: 'silent' });
  const { output } = await bundle.generate({ format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(output[0].code, 'utf8').toString('base64')}`);
}
const acts = await load('mascotActs.ts');
const picks = await load('mascotPicks.ts');
const reaction = await load('mascotReaction.ts');
const css = await fs.readFile(new URL('../styles.css', import.meta.url), 'utf8');

test('every act and face is complete, static markup', () => {
  assert.equal(acts.ACT_IDS.length, 15);
  assert.equal(acts.FACE_NAMES.length, 15);
  for (const id of acts.ACT_IDS) {
    const act = acts.ACTS[id];
    assert.equal(act.cls, `a-${id}`);
    assert.ok(act.name && act.says && act.face, id);
  }
  const markup = [...acts.ACT_IDS.flatMap(id => Object.values(acts.ACTS[id]).filter(v => typeof v === 'string')), ...Object.values(acts.FACES)];
  for (const html of markup) {
    // Authored in this repository and rendered as HTML: nothing executable, ever.
    assert.doesNotMatch(html, /<script|<foreignObject|javascript:|\son\w+\s*=|<iframe|href=/i);
    assert.equal((html.match(/<g[\s>]/g) || []).length, (html.match(/<\/g>/g) || []).length, 'balanced groups');
  }
});

test('each act has styles, and the animation keyframes it names exist', () => {
  for (const id of acts.ACT_IDS) assert.match(css, new RegExp(`\\.a-${id}[ .{,]`), `${id} has rules in styles.css`);
  const names = new Set([...css.matchAll(/@keyframes ([\w-]+)/g)].map(m => m[1]));
  for (const used of new Set([...css.matchAll(/animation:\s*([\w-]+)\s/g)].map(m => m[1]))) {
    if (/^(k-|gO)/.test(used)) assert.ok(names.has(used), `keyframes ${used} exist`);
  }
});

test('a container query never toggles display: Chrome restarts the animations inside', () => {
  // Found live: a display:none rule in @container made the typing log and the thought bubble
  // cancel and restart about once a second. Hide with visibility instead.
  for (const block of css.matchAll(/@container[^{]*\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
    assert.doesNotMatch(block[1], /display\s*:\s*none/, block[0].slice(0, 80));
  }
});

test('each stage picks from its pool and never repeats the previous scan', () => {
  for (const [stage, pool] of Object.entries(picks.ACT_POOLS)) {
    for (const id of pool) assert.ok(acts.ACT_IDS.includes(id), `${stage}: ${id}`);
    for (const last of pool) {
      for (const r of [0, 0.3, 0.5, 0.99]) {
        const next = picks.pickAct(stage, last, () => r);
        assert.ok(pool.includes(next));
        if (pool.length > 1) assert.notEqual(next, last, `${stage} repeated ${last}`);
      }
    }
  }
  assert.equal(picks.pickAct('downloading', 'fish', () => 0.5), 'fish', 'a single act has to repeat');
  // The remembered sequence across scans.
  let previous;
  for (let i = 0; i < 40; i++) { const id = picks.chooseAct('queued'); assert.notEqual(id, previous); previous = id; }
  assert.equal(picks.LONG_WAIT_ACT, 'nap');
});

const file = (report, size = 4096) => ({ id: 'f', file: { name: 'x.dmp', size }, status: 'analyzed', report });
test('the finish reaction follows how the report came out', () => {
  const r = reaction.reactionFor;
  assert.equal(r(file({ bugCheck: { code: '0x000001C8' }, culprit: 'Unknown' })), 'unsure', 'a forced crash does not document its cause');
  assert.equal(r(file({ bugCheck: { code: '0xE2' }, culprit: 'bad.sys' })), 'unsure');
  assert.equal(r(file({ bugCheck: { code: '0x00000117' }, culprit: 'nvlddmkm.sys' })), 'good', 'a recovered live dump');
  assert.equal(r(file({ bugCheck: { code: '0x124' }, culprit: 'Unknown' })), 'hot');
  assert.equal(r(file({ bugCheck: { code: '0xD1' }, culprit: 'x', hardwareError: { isHardwareError: true } })), 'hot');
  assert.equal(r(file({ bugCheck: { code: '0x0000001A' }, culprit: 'ntoskrnl.exe' })), 'memory');
  assert.equal(r(file({ bugCheck: { code: '0x50' }, culprit: 'ntoskrnl.exe' })), 'memory');
  assert.equal(r(file({ bugCheck: { code: '0xD1' }, culprit: 'nvlddmkm.sys' })), 'driver');
  assert.equal(r(file({ bugCheck: { code: '0xD1' }, culprit: 'ntfs.sys' })), 'unsure', 'a Windows driver says little about a third party');
  assert.equal(r(file({ bugCheck: { code: '0xA' }, culprit: 'ntoskrnl.exe' }, 80 * 1024 * 1024)), 'lift', 'a big kernel dump with a culprit');
  assert.equal(r(file({ bugCheck: { code: '0xA' }, culprit: 'Unknown (not captured in this dump)' }, 80 * 1024 * 1024)), 'unsure');
  assert.equal(r(file({ bugCheck: { code: '0xD1' }, culprit: '' })), 'unsure');
  assert.equal(r(undefined), 'unsure');
  assert.equal(r({ id: 'f', file: { name: 'x', size: 1 }, status: 'analyzed' }), 'unsure');
});
