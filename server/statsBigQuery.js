// Crash-statistics aggregation over BigQuery.
//
// Each completed analysis writes one `stats.analysis` log line; the Cloud
// Logging sink `bsod-stats-events` streams those lines into
// <project>.<dataset>.<table> (partitioned by timestamp). Aggregates are
// computed here with SQL, so they are durable, exact across instances and
// restarts, and never depend on Upstash. The dataset also holds `baseline`:
// a one-time export of the pre-cutover Upstash aggregates
// (scripts/export-stats-baseline.mjs), merged in by server/statsStore.js.
//
// Talks to the BigQuery REST API with the Cloud Run service account's token
// from the metadata server — no client library needed.

import { createGcpMetadataAuth } from './gcpMetadata.js';

const BIGQUERY = 'https://bigquery.googleapis.com/bigquery/v2';
const QUERY_TIMEOUT_MS = 20_000;
const IDENTIFIER_RE = /^[A-Za-z0-9_-]+$/;

// Aggregates mirror the previous Upstash counters: one counted event per
// (file hash, UTC day) — the first one — for every breakdown; the activity
// gauges count every run. Only real analysis sources count.
export function eventsQuery(table) {
  return `
WITH events AS (
  SELECT
    timestamp AS ts,
    NULLIF(LOWER(jsonPayload.file_hash), '') AS file_hash,
    jsonPayload.source AS source,
    NULLIF(jsonPayload.stop_code, '') AS stop_code,
    NULLIF(jsonPayload.stop_code_label, '') AS stop_code_label,
    NULLIF(jsonPayload.failure_bucket, '') AS failure_bucket,
    NULLIF(jsonPayload.module, '') AS module,
    NULLIF(jsonPayload.os_version, '') AS os_version,
    NULLIF(jsonPayload.dump_type, '') AS dump_type
  FROM \`${table}\`
  WHERE jsonPayload.event = 'stats.analysis'
    AND jsonPayload.source IN ('windbg', 'ai-fallback')
),
counted AS (
  SELECT * EXCEPT (rn) FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY file_hash, DATE(ts) ORDER BY ts) AS rn
    FROM events
  )
  WHERE file_hash IS NULL OR rn = 1
)
SELECT TO_JSON_STRING(STRUCT(
  (SELECT COUNT(*) FROM counted) AS total,
  (SELECT MIN(ts) FROM counted) AS tracking_since,
  (SELECT COUNT(*) FROM events WHERE DATE(ts) = CURRENT_DATE()) AS runs_today,
  (SELECT COUNT(*) FROM events WHERE ts >= TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), HOUR)) AS last_hour,
  ARRAY(SELECT AS STRUCT source AS k, COUNT(*) AS n FROM counted GROUP BY k) AS sources,
  ARRAY(SELECT AS STRUCT IFNULL(dump_type, 'unknown') AS k, COUNT(*) AS n FROM counted GROUP BY k) AS dump_types,
  ARRAY(SELECT AS STRUCT os_version AS k, COUNT(*) AS n FROM counted
        WHERE os_version IS NOT NULL GROUP BY k) AS os_versions,
  ARRAY(SELECT AS STRUCT stop_code AS k, COUNT(*) AS n,
          ARRAY_AGG(stop_code_label IGNORE NULLS ORDER BY ts DESC LIMIT 1)[SAFE_OFFSET(0)] AS label
        FROM counted WHERE stop_code IS NOT NULL GROUP BY k) AS stop_codes,
  ARRAY(SELECT AS STRUCT failure_bucket AS k, COUNT(*) AS n FROM counted
        WHERE failure_bucket IS NOT NULL GROUP BY k ORDER BY n DESC LIMIT 500) AS buckets,
  ARRAY(SELECT AS STRUCT module AS k, COUNT(*) AS n FROM counted
        WHERE module IS NOT NULL GROUP BY k ORDER BY n DESC LIMIT 500) AS modules,
  ARRAY(SELECT AS STRUCT FORMAT_DATE('%Y%m%d', DATE(ts)) AS k, COUNT(*) AS n FROM counted
        WHERE DATE(ts) >= DATE_SUB(CURRENT_DATE(), INTERVAL @window_days DAY) GROUP BY k) AS daily
)) AS aggregates`;
}

function baselineQuery(table) {
  return `SELECT raw FROM \`${table}\` ORDER BY captured_at DESC LIMIT 1`;
}

// Converts the SQL row into the raw aggregate shape server/stats.js expects.
export function rawFromAggregates(row) {
  const toMap = list => Object.fromEntries((list || []).map(({ k, n }) => [k, Number(n)]));
  const toPairs = list => (list || []).map(({ k, n }) => [k, Number(n)]);
  const labels = {};
  for (const { k, label } of row.stop_codes || []) {
    if (label) labels[k] = label;
  }
  const since = row.tracking_since ? new Date(row.tracking_since) : null;
  return {
    total: Number(row.total) || 0,
    sources: toMap(row.sources),
    dumpTypes: toMap(row.dump_types),
    osVersions: toMap(row.os_versions),
    stopCodes: toMap(row.stop_codes),
    stopCodeLabels: labels,
    buckets: toPairs(row.buckets),
    modules: toPairs(row.modules),
    daily: toPairs(row.daily),
    lastHour: Number(row.last_hour) || 0,
    runsToday: Number(row.runs_today) || 0,
    trackingSince: since && !Number.isNaN(since.getTime()) ? since.toISOString() : null
  };
}

const EMPTY_LIVE = rawFromAggregates({});

export function createBigQueryStatsSource({
  dataset = 'bsod_stats',
  table = 'run_googleapis_com_stdout',
  projectId,
  fetchImpl = globalThis.fetch,
  getAccessToken
} = {}) {
  if (!IDENTIFIER_RE.test(dataset) || !IDENTIFIER_RE.test(table)) {
    throw new TypeError('BigQuery dataset/table names must be plain identifiers');
  }
  const { accessToken, projectIdentifier } = createGcpMetadataAuth({ projectId, getAccessToken, fetchImpl });

  // Runs one standard-SQL query and returns its rows' first column values.
  async function runQuery(query, parameters = []) {
    const projectName = await projectIdentifier();
    const res = await fetchImpl(`${BIGQUERY}/projects/${projectName}/queries`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query,
        useLegacySql: false,
        parameterMode: 'NAMED',
        queryParameters: parameters,
        timeoutMs: QUERY_TIMEOUT_MS
      }),
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS + 5000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(body?.error?.message || `BigQuery HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }
    if (!body.jobComplete) throw new Error('BigQuery query did not complete in time');
    return (body.rows || []).map(row => row.f?.[0]?.v ?? null);
  }

  // Returns { live, baseline } raw aggregates. A missing events table means
  // no analysis has been logged since the sink was created.
  async function load({ windowDays }) {
    const projectName = await projectIdentifier();
    const events = `${projectName}.${dataset}.${table}`;
    const [liveRows, baselineRows] = await Promise.all([
      runQuery(eventsQuery(events), [{
        name: 'window_days',
        parameterType: { type: 'INT64' },
        parameterValue: { value: String(windowDays) }
      }]).catch(error => {
        if (error.status === 404) return null;
        throw error;
      }),
      runQuery(baselineQuery(`${projectName}.${dataset}.baseline`)).catch(error => {
        console.warn('[Stats] baseline read failed:', error?.message || error);
        return [];
      })
    ]);
    const live = liveRows?.[0] ? rawFromAggregates(JSON.parse(liveRows[0])) : EMPTY_LIVE;
    let baseline = null;
    if (baselineRows[0]) {
      try {
        baseline = JSON.parse(baselineRows[0]);
      } catch {
        console.warn('[Stats] baseline row is not valid JSON; ignoring it');
      }
    }
    return { live, baseline };
  }

  return { load };
}
