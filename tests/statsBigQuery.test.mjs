import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBigQueryStatsSource, rawFromAggregates } from '../server/statsBigQuery.js';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeFetch(handlers) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [match, handler] of handlers) {
      if (String(url).includes(match)) return handler(String(url), init);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { impl, calls };
}

function queryBody(init) {
  return JSON.parse(init.body);
}

const AGGREGATES = {
  total: 3,
  tracking_since: '2026-09-26T03:21:25.786359Z',
  runs_today: 4,
  last_hour: 2,
  sources: [{ k: 'windbg', n: 3 }],
  dump_types: [{ k: 'unknown', n: 1 }, { k: 'kernel', n: 2 }],
  os_versions: [],
  stop_codes: [{ k: '0x3B', n: 3, label: null }],
  buckets: [],
  modules: [{ k: 'ntkrnlmp.exe', n: 3 }],
  daily: [{ k: '20260926', n: 3 }]
};

test('rawFromAggregates maps the SQL row onto the snapshot input shape', () => {
  const raw = rawFromAggregates(AGGREGATES);
  assert.equal(raw.total, 3);
  assert.equal(raw.trackingSince, '2026-09-26T03:21:25.786Z');
  assert.deepEqual(raw.dumpTypes, { unknown: 1, kernel: 2 });
  assert.deepEqual(raw.stopCodes, { '0x3B': 3 });
  assert.deepEqual(raw.stopCodeLabels, {});
  assert.deepEqual(raw.modules, [['ntkrnlmp.exe', 3]]);
  assert.equal(raw.runsToday, 4);
  assert.equal(raw.lastHour, 2);
  assert.equal(rawFromAggregates({}).trackingSince, null);
});

test('load queries events + baseline with the metadata token and project', async () => {
  const { impl, calls } = fakeFetch([
    ['service-accounts/default/token', () => jsonResponse(200, { access_token: 'tok', expires_in: 3600 })],
    ['project/project-id', () => new Response('demo-project')],
    ['/queries', (_url, init) => {
      const body = queryBody(init);
      if (body.query.includes('baseline')) {
        return jsonResponse(200, { jobComplete: true, rows: [{ f: [{ v: JSON.stringify({ total: 10 }) }] }] });
      }
      return jsonResponse(200, { jobComplete: true, rows: [{ f: [{ v: JSON.stringify(AGGREGATES) }] }] });
    }]
  ]);
  const source = createBigQueryStatsSource({ fetchImpl: impl });
  const { live, baseline } = await source.load({ windowDays: 90 });

  assert.equal(live.total, 3);
  assert.deepEqual(baseline, { total: 10 });
  const queries = calls.filter(c => c.url.endsWith('/projects/demo-project/queries'));
  assert.equal(queries.length, 2);
  assert.equal(queries[0].init.headers.Authorization, 'Bearer tok');
  const eventsQuery = queries.map(c => queryBody(c.init)).find(b => !b.query.includes('baseline'));
  assert.match(eventsQuery.query, /`demo-project\.bsod_stats\.run_googleapis_com_stdout`/);
  assert.deepEqual(eventsQuery.queryParameters[0].parameterValue, { value: '90' });

  // Token and project id are cached across loads.
  await source.load({ windowDays: 90 });
  assert.equal(calls.filter(c => c.url.includes('metadata')).length, 2);
});

test('a missing events table means no events yet, not an error', async () => {
  const { impl } = fakeFetch([
    ['/queries', (_url, init) => (queryBody(init).query.includes('baseline')
      ? jsonResponse(200, { jobComplete: true, rows: [] })
      : jsonResponse(404, { error: { message: 'Not found: Table demo:bsod_stats.run_googleapis_com_stdout' } }))]
  ]);
  const source = createBigQueryStatsSource({ fetchImpl: impl, projectId: 'demo', getAccessToken: async () => 't' });
  const { live, baseline } = await source.load({ windowDays: 90 });
  assert.equal(live.total, 0);
  assert.equal(baseline, null);
});

test('query failures and incomplete jobs surface as errors', async () => {
  const failing = createBigQueryStatsSource({
    projectId: 'demo',
    getAccessToken: async () => 't',
    fetchImpl: fakeFetch([['/queries', () => jsonResponse(403, { error: { message: 'Access Denied' } })]]).impl
  });
  await assert.rejects(failing.load({ windowDays: 90 }), /Access Denied/);

  const slow = createBigQueryStatsSource({
    projectId: 'demo',
    getAccessToken: async () => 't',
    fetchImpl: fakeFetch([['/queries', () => jsonResponse(200, { jobComplete: false })]]).impl
  });
  await assert.rejects(slow.load({ windowDays: 90 }), /did not complete/);
});

test('dataset and table names are restricted to plain identifiers', () => {
  assert.throws(() => createBigQueryStatsSource({ table: 'x`; DROP' }), /plain identifiers/);
});
