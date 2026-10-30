import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { transform } from 'rolldown/experimental';
import { createGcsStatsSource, STATS_FILES } from '../server/statsGcsSource.js';

async function loadHelper() {
  const source = await fs.readFile(new URL('../utils/statsMath.ts', import.meta.url), 'utf8');
  const result = await transform('statsMath.ts', source);
  return import(`data:text/javascript;base64,${Buffer.from(result.code, 'utf8').toString('base64')}`);
}

test('first-minute share divides by the known-uptime count, like the histogram and priors (issue #300)', async () => {
  const { firstMinuteShare } = await loadHelper();
  const share = firstMinuteShare({ analyses: 21532, uptime_known: 20374, crashes_within_first_minute: 1264 });
  assert.equal((share * 100).toFixed(2), '6.20');
});

test('older exports without uptime_known fall back to all analyses (issue #300)', async () => {
  const { firstMinuteShare } = await loadHelper();
  const share = firstMinuteShare({ analyses: 21532, crashes_within_first_minute: 1264 });
  assert.equal((share * 100).toFixed(2), '5.87');
});

test('no usable denominator gives null rather than NaN or Infinity (issue #300)', async () => {
  const { firstMinuteShare } = await loadHelper();
  assert.equal(firstMinuteShare({ analyses: 0, crashes_within_first_minute: 0 }), null);
  assert.equal(firstMinuteShare({ analyses: 50, uptime_known: 0, crashes_within_first_minute: 0 }), null);
});

test('the corpus-insights query exports totals.uptime_known as the non-null uptime count (issue #300)', async () => {
  const sql = await fs.readFile(new URL('../bigquery/crash_insights.sql', import.meta.url), 'utf8');
  assert.match(sql, /\(SELECT COUNTIF\(uptime_seconds IS NOT NULL\) FROM t\) AS uptime_known/);
  const totals = sql.slice(sql.indexOf('STRUCT(\n    (SELECT COUNT(*) FROM t) AS analyses'), sql.indexOf(') AS totals'));
  assert.match(totals, /uptime_known/, 'uptime_known sits inside the totals struct');
});

test('the stats source passes totals.uptime_known through to the snapshot (issue #300)', async () => {
  const payload = { schema: 'bsod_corpus_insights_v1', totals: { analyses: 100, uptime_known: 90, crashes_within_first_minute: 9 } };
  const reader = { read: async file => {
    if (file === STATS_FILES.live) return [{ generated_at: 'z', aggregates: JSON.stringify({ total: 3, tracking_since: '2026-09-26T03:46:24Z', runs_today: 2, last_hour: 1, sources: [], stop_codes: [], daily: [] }) }];
    if (file === STATS_FILES.insights) return [{ generated_at: 'z', payload: JSON.stringify(payload) }];
    const error = new Error('missing'); error.status = 404; throw error;
  } };
  const { insights } = await createGcsStatsSource({ reader }).load();
  assert.equal(insights.totals.uptime_known, 90);
});
