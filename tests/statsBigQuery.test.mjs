import { test } from 'node:test';
import assert from 'node:assert/strict';

import { eventsQuery, rawFromAggregates } from '../server/statsBigQuery.js';

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

test('eventsQuery reads stats.analysis events from the given table', () => {
  const sql = eventsQuery('proj.bsod_stats.events');
  assert.match(sql, /FROM `proj\.bsod_stats\.events`/);
  assert.match(sql, /jsonPayload\.event = 'stats\.analysis'/);
  assert.match(sql, /@window_days/);
});
