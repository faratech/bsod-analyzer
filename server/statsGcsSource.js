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
      live: rawFromAggregates(liveAggregates || {}),
      baseline: firstJsonField(baselineRows, 'raw'),
      insights: firstJsonField(insightRows, 'payload')
    };
  }
  return { load };
}
