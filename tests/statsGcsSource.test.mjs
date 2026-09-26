import test from 'node:test';
import assert from 'node:assert/strict';
import { STATS_FILES, createGcsStatsSource } from '../server/statsGcsSource.js';

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
    [STATS_FILES.live]: [{ generated_at: 'x', aggregates: JSON.stringify(live) }],
    [STATS_FILES.baseline]: [{ captured_at: 'y', raw: JSON.stringify({ total: 100, trackingSince: '2026-06-19T00:00:00Z' }) }],
    [STATS_FILES.insights]: [{ generated_at: 'z', payload: JSON.stringify({ schema: 'bsod_corpus_insights_v1', totals: { analyses: 103 } }) }]
  });
  const { live: l, baseline, insights } = await createGcsStatsSource({ reader: r }).load();
  assert.equal(l.total, 3);
  assert.equal(l.runsToday, 2);
  assert.equal(l.stopCodes['0x116'], 2);
  assert.equal(baseline.total, 100);
  assert.equal(insights.totals.analyses, 103);
  assert.deepEqual(r.reads.sort(), Object.values(STATS_FILES).sort());
});

test('missing files degrade to empty live, no baseline and no insights', async () => {
  const { live: l, baseline, insights } = await createGcsStatsSource({ reader: reader({}) }).load();
  assert.equal(l.total, 0);
  assert.equal(baseline, null);
  assert.equal(insights, null);
});

test('a failing live file surfaces, optional files only warn', async () => {
  const boom = Object.assign(new Error('HTTP 500'), { status: 500 });
  await assert.rejects(createGcsStatsSource({ reader: reader({ [STATS_FILES.live]: boom }) }).load(), /HTTP 500/);
  const ok = await createGcsStatsSource({ reader: reader({
    [STATS_FILES.live]: [{ aggregates: JSON.stringify(live) }], [STATS_FILES.insights]: boom
  }) }).load();
  assert.equal(ok.insights, null);
  assert.equal(ok.live.total, 3);
});
