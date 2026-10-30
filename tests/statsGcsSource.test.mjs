import test from 'node:test';
import assert from 'node:assert/strict';
import { STATS_FILES, createGcsStatsSource } from '../server/statsGcsSource.js';
import { createStatsStore } from '../server/statsStore.js';

function reader(files) {
  const reads = [];
  return {
    reads,
    read: async (path) => {
      reads.push(path);
      const value = files[path];
      if (value instanceof Error) throw value;
      if (value === undefined) { const e = new Error('404'); e.status = 404; throw e; }
      return value;
    }
  };
}

const live = { total: 3, tracking_since: '2026-09-26T03:46:24Z', runs_today: 2, last_hour: 1,
  sources: [{ k: 'windbg', n: 3 }], stop_codes: [{ k: '0x116', n: 2, label: 'VIDEO_TDR_FAILURE' }], daily: [{ k: '20260926', n: 3 }] };

test('load maps the exported live, baseline and insights files', async () => {
  const r = reader({
    [STATS_FILES.live]: [{ generated_at: '2026-09-27 23:40:01.123456 UTC', aggregates: JSON.stringify(live) }],
    [STATS_FILES.baseline]: [{ captured_at: 'y', raw: JSON.stringify({ total: 100, trackingSince: '2026-06-19T00:00:00Z' }) }],
    [STATS_FILES.insights]: [{ generated_at: 'z', payload: JSON.stringify({ schema: 'bsod_corpus_insights_v1', totals: { analyses: 103 } }) }]
  });
  const { live: l, baseline, insights } = await createGcsStatsSource({ reader: r }).load();
  assert.equal(l.total, 3);
  assert.equal(l.runsToday, 2);
  assert.equal(l.asOf, '2026-09-27T23:40:01.123Z');
  assert.equal(l.stopCodes['0x116'], 2);
  assert.equal(baseline.total, 100);
  assert.equal(insights.totals.analyses, 103);
  assert.deepEqual(r.reads.sort(), Object.values(STATS_FILES).sort());
});

test('missing baseline and insights files degrade to null', async () => {
  const { live: l, baseline, insights } = await createGcsStatsSource({ reader: reader({
    [STATS_FILES.live]: [{ aggregates: JSON.stringify(live) }]
  }) }).load();
  assert.equal(l.total, 3);
  assert.equal(baseline, null);
  assert.equal(insights, null);
});

test('a missing or empty live export is an error, never an all-zero snapshot (issue #250)', async () => {
  await assert.rejects(createGcsStatsSource({ reader: reader({}) }).load(), error => error?.status === 404);
  await assert.rejects(createGcsStatsSource({ reader: reader({ [STATS_FILES.live]: [] }) }).load(), /live stats export/);
  await assert.rejects(createGcsStatsSource({ reader: reader({ [STATS_FILES.live]: [{ generated_at: 'x' }] }) }).load(), /live stats export/);
});

test('a cold instance with no live export answers null instead of memoizing zeros (issue #250)', async () => {
  let files = {};
  const source = createGcsStatsSource({ reader: { read: async path => reader(files).read(path) } });
  const store = createStatsStore({ source, emit: () => {} });
  assert.equal(await store.buildSnapshot(), null, 'the route answers 503 rather than a confident zero');
  assert.equal(store.getSnapshot(), null, 'nothing is memoized, so the next request retries');

  files = { [STATS_FILES.live]: [{ aggregates: JSON.stringify(live) }] };
  const snapshot = await store.buildSnapshot();
  assert.equal(snapshot.totals.analyses, 3);
});

test('a failing live file surfaces, optional files only warn', async () => {
  const boom = Object.assign(new Error('HTTP 500'), { status: 500 });
  await assert.rejects(createGcsStatsSource({ reader: reader({ [STATS_FILES.live]: boom }) }).load(), /HTTP 500/);
  const ok = await createGcsStatsSource({ reader: reader({
    [STATS_FILES.live]: [{ aggregates: JSON.stringify(live) }], [STATS_FILES.insights]: boom
  }) }).load();
  assert.equal(ok.insights, null);
  assert.equal(ok.live.total, 3);
  assert.equal(ok.live.asOf, null);
});

test('corrupt optional-file JSON degrades to null and never fails the snapshot', async () => {
  // A partial/corrupt export leaves valid JSON rows with a bad `raw`/`payload`
  // string column: the parse must degrade exactly like a failed read (issue #114).
  const { live: l, baseline, insights } = await createGcsStatsSource({ reader: reader({
    [STATS_FILES.live]: [{ generated_at: '2026-09-27 23:40:01.123456 UTC', aggregates: JSON.stringify(live) }],
    [STATS_FILES.baseline]: [{ captured_at: 'y', raw: '{not json' }],
    [STATS_FILES.insights]: [{ generated_at: 'z', payload: '{also not json' }]
  }) }).load();
  assert.equal(l.total, 3);
  assert.equal(baseline, null);
  assert.equal(insights, null);
});
