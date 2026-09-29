// /api/stats data source: reads the JSON the BigQuery scheduled queries publish
// to Cloud Storage (bigquery/live_stats.sql hourly, bigquery/crash_insights.sql
// daily). Cloud Run never queries BigQuery, so query cost is fixed by the
// schedules, not by traffic.
import { rawFromAggregates } from './statsBigQuery.js';

export const STATS_FILES = Object.freeze({
  live: 'live/000000000000.json',
  baseline: 'baseline/000000000000.json',
  insights: 'insights/000000000000.json'
});

function firstJsonField(rows, field) {
  const value = rows?.[0]?.[field];
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

// Baseline/insights are best-effort: a corrupt string column in their export
// must degrade to null exactly like a failed read, never fail the whole
// snapshot build (issue #114). The live file stays strict.
function optionalJsonField(rows, field, label) {
  try {
    return firstJsonField(rows, field);
  } catch (error) {
    console.warn(`[Stats] ${label} parse failed:`, error?.message || error);
    return null;
  }
}

async function optional(promise) {
  try {
    return await promise;
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

export function createGcsStatsSource({ reader, files = STATS_FILES } = {}) {
  async function load() {
    const [liveRows, baselineRows, insightRows] = await Promise.all([
      optional(reader.read(files.live)),
      optional(reader.read(files.baseline)).catch(error => {
        console.warn('[Stats] baseline read failed:', error?.message || error);
        return null;
      }),
      optional(reader.read(files.insights)).catch(error => {
        console.warn('[Stats] insights read failed:', error?.message || error);
        return null;
      })
    ]);
    const liveAggregates = firstJsonField(liveRows, 'aggregates');
    return {
      // generated_at is when the scheduled query ran: its CURRENT_DATE() is the
      // day that runs_today, last_hour and the newest daily bucket describe.
      live: rawFromAggregates(liveAggregates || {}, { asOf: liveRows?.[0]?.generated_at }),
      baseline: optionalJsonField(baselineRows, 'raw', 'baseline'),
      insights: optionalJsonField(insightRows, 'payload', 'insights')
    };
  }
  return { load };
}
