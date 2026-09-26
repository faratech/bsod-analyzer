import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createStatsStore } from '../server/statsStore.js';
import { rawFromAggregates } from '../server/statsBigQuery.js';

const FACTS = {
  fileHash: 'abcdef0123456789',
  source: 'windbg',
  stopCode: '0x3B',
  stopCodeLabel: 'SYSTEM_SERVICE_EXCEPTION',
  failureBucket: 'AV_nt!KiSystemServiceCopyEnd',
  module: 'ntkrnlmp.exe',
  osVersion: '10.0.26100',
  dumpType: 'kernel'
};

function liveRaw(overrides = {}) {
  return {
    ...rawFromAggregates({
      total: 2,
      tracking_since: '2026-09-26T03:00:00.123456Z',
      runs_today: 3,
      last_hour: 1,
      sources: [{ k: 'windbg', n: 2 }],
      dump_types: [{ k: 'kernel', n: 2 }],
      os_versions: [{ k: '10.0.26100', n: 2 }],
      stop_codes: [{ k: '0x3B', n: 2, label: 'SYSTEM_SERVICE_EXCEPTION' }],
      buckets: [{ k: 'AV_nt!KiSystemServiceCopyEnd', n: 2 }],
      modules: [{ k: 'ntkrnlmp.exe', n: 2 }],
      daily: [{ k: '20260926', n: 2 }]
    }),
    ...overrides
  };
}

function fakeSource(results) {
  const calls = [];
  return {
    calls,
    async load(args) {
      calls.push(args);
      const next = results.shift();
      if (next instanceof Error) throw next;
      return next;
    }
  };
}

test('recordAnalysis logs one event with every field as a string', () => {
  const events = [];
  const store = createStatsStore({ emit: (event, fields) => events.push({ event, fields }) });

  assert.equal(store.recordAnalysis(FACTS), true);
  assert.equal(store.recordAnalysis({ ...FACTS, source: 'ai-fallback', fileHash: undefined, dumpType: undefined }), true);
  assert.deepEqual(events[0], {
    event: 'stats.analysis',
    fields: {
      source: 'windbg',
      file_hash: 'abcdef0123456789',
      stop_code: '0x3B',
      stop_code_label: 'SYSTEM_SERVICE_EXCEPTION',
      failure_bucket: 'AV_nt!KiSystemServiceCopyEnd',
      module: 'ntkrnlmp.exe',
      os_version: '10.0.26100',
      dump_type: 'kernel'
    }
  });
  assert.equal(events[1].fields.file_hash, '');
  assert.equal(events[1].fields.dump_type, 'unknown');
});

test('unknown sources, disabled stores and emit failures record nothing', () => {
  const events = [];
  const store = createStatsStore({ emit: (event, fields) => events.push(fields) });
  assert.equal(store.recordAnalysis({ ...FACTS, source: 'schema-probe' }), false);
  assert.equal(store.recordAnalysis(null), false);

  const disabled = createStatsStore({ emit: () => events.push('x'), isEnabled: () => false });
  assert.equal(disabled.recordAnalysis(FACTS), false);
  assert.equal(events.length, 0);

  const throwing = createStatsStore({ emit: () => { throw new Error('stdout closed'); } });
  assert.equal(throwing.recordAnalysis(FACTS), false);
});

test('buildSnapshot shapes the source aggregates and memoizes them for the TTL', async () => {
  let clock = Date.UTC(2026, 8, 26, 12);
  const source = fakeSource([{ live: liveRaw(), baseline: null }, { live: liveRaw({ total: 5 }), baseline: null }]);
  const store = createStatsStore({ source, now: () => clock, snapshotTtlSeconds: 60 });

  assert.equal(store.getSnapshot(), null);
  const snapshot = await store.buildSnapshot();
  assert.equal(snapshot.totals.analyses, 2);
  assert.equal(snapshot.gauges.runsToday, 3);
  assert.equal(snapshot.trackingSince, '2026-09-26T03:00:00.123Z');
  assert.equal(snapshot.topStopCodes.items[0].label, 'SYSTEM_SERVICE_EXCEPTION');
  assert.equal(source.calls[0].windowDays, 90);

  clock += 30_000;
  assert.equal(store.getSnapshot(), snapshot);
  clock += 31_000;
  assert.equal(store.getSnapshot(), null);
  assert.equal((await store.buildSnapshot()).totals.analyses, 5);
});

test('concurrent rebuilds share one source query', async () => {
  const source = fakeSource([{ live: liveRaw(), baseline: null }]);
  const store = createStatsStore({ source });
  const [a, b] = await Promise.all([store.buildSnapshot(), store.buildSnapshot()]);
  assert.equal(a, b);
  assert.equal(source.calls.length, 1);
});

test('a failed rebuild keeps serving the last good snapshot', async () => {
  const source = fakeSource([new Error('BigQuery down'), { live: liveRaw(), baseline: null }, new Error('BigQuery down')]);
  const store = createStatsStore({ source, snapshotTtlSeconds: 0 });
  assert.equal(await store.buildSnapshot(), null);
  const good = await store.buildSnapshot();
  assert.equal(good.totals.analyses, 2);
  assert.equal(await store.buildSnapshot(), good);
});

test('the pre-cutover baseline is folded into the live aggregates', async () => {
  const baseline = {
    total: 100,
    sources: { windbg: 60, 'ai-fallback': 40 },
    dumpTypes: { minidump: 70, kernel: 30 },
    osVersions: { '10.0.22631': 100 },
    stopCodes: { '0x3B': 10, '0xD1': 90 },
    stopCodeLabels: { '0xD1': 'DRIVER_IRQL_NOT_LESS_OR_EQUAL' },
    buckets: [['AV_nt!KiSystemServiceCopyEnd', 5]],
    modules: [['ntkrnlmp.exe', 8], ['nvlddmkm.sys', 50]],
    daily: [['20260920', 7]],
    trackingSince: '2026-08-23T20:00:00.000Z'
  };
  const store = createStatsStore({
    source: fakeSource([{ live: liveRaw(), baseline }]),
    now: () => Date.UTC(2026, 8, 26, 12)
  });
  const snapshot = await store.buildSnapshot();
  assert.equal(snapshot.totals.analyses, 102);
  assert.equal(snapshot.trackingSince, '2026-08-23T20:00:00.000Z');
  assert.deepEqual(snapshot.topStopCodes.items.map(i => [i.value, i.count]), [['0xD1', 90], ['0x3B', 12]]);
  assert.deepEqual(snapshot.topModules.items.map(i => [i.value, i.count]), [['nvlddmkm.sys', 50], ['ntkrnlmp.exe', 10]]);
  assert.equal(snapshot.daily.find(d => d.date === '20260920').count, 7);
  assert.equal(snapshot.daily.find(d => d.date === '20260926').count, 2);
  assert.equal(snapshot.gauges.runsToday, 3); // live-only gauge
});
