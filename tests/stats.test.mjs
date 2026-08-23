import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractStatsFacts,
  normalizeStopCode,
  normalizeOsVersion,
  normalizeFailureBucket,
  normalizeModuleKey,
  normalizeDumpType,
  utcDay,
  buildSnapshot
} from '../server/stats.js';

test('normalizeStopCode canonicalizes hex/decimal/paren forms', () => {
  assert.deepEqual(normalizeStopCode('0x0000001A'), { code: '0x1A', label: undefined });
  assert.deepEqual(normalizeStopCode(126), { code: '0x7E', label: undefined });
  const paren = normalizeStopCode('0x7E (SYSTEM_THREAD_EXCEPTION_NOT_HANDLED)');
  assert.equal(paren.code, '0x7E');
  assert.equal(paren.label, 'SYSTEM_THREAD_EXCEPTION_NOT_HANDLED');
  assert.equal(normalizeStopCode(''), undefined);
  assert.equal(normalizeStopCode(null), undefined);
  assert.equal(normalizeStopCode('not-a-code'), undefined);
});

test('normalizers bound cardinality', () => {
  assert.equal(normalizeFailureBucket('AV_nt!ExFreePool+0x12'), 'AV_nt!ExFreePool');
  assert.equal(normalizeFailureBucket('x'.repeat(200)), undefined);
  assert.equal(normalizeModuleKey('Nvlddmkm.SYS'), 'nvlddmkm.sys');
  assert.equal(normalizeModuleKey('bad module name!'), undefined);
  assert.equal(normalizeOsVersion('10.0.26100.1'), '10.0.26100');
  assert.equal(normalizeOsVersion('Windows NT Kernel Version 10.0.19045.123'), '10.0.19045');
  assert.equal(normalizeDumpType('Kernel'), 'kernel');
  assert.equal(normalizeDumpType('zip'), undefined);
});

test('extractStatsFacts reads windbg structured signal', () => {
  const facts = extractStatsFacts({
    source: 'windbg',
    fileHash: 'ABCDEF0123456789',
    structured: {
      bugcheck: { code: '0x0000001A', name: 'MEMORY_MANAGEMENT' },
      crash: { failureBucketId: 'AV_nt!ExFreePool+0x12', imageName: 'nvlddmkm.SYS' }
    },
    analysisText: 'OS_VERSION: 10.0.26100.1'
  });
  assert.equal(facts.fileHash, 'abcdef0123456789');
  assert.equal(facts.stopCode, '0x1A');
  assert.equal(facts.stopCodeLabel, 'MEMORY_MANAGEMENT');
  assert.equal(facts.failureBucket, 'AV_nt!ExFreePool');
  assert.equal(facts.module, 'nvlddmkm.sys');
  assert.equal(facts.osVersion, '10.0.26100');
});

test('extractStatsFacts reads ai-fallback report + prompt dump type', () => {
  const facts = extractStatsFacts({
    source: 'ai-fallback',
    fileHash: 'deadbeef00112233',
    aiReport: {
      bugCheckCode: '0x7E (SYSTEM_THREAD_EXCEPTION_NOT_HANDLED)',
      culprit: 'nvlddmkm.sys',
      systemInfo: { windowsVersion: '10.0.19045' }
    },
    promptText: '- Dump Type: minidump\nmore text'
  });
  assert.equal(facts.source, 'ai-fallback');
  assert.equal(facts.stopCode, '0x7E');
  assert.equal(facts.stopCodeLabel, 'SYSTEM_THREAD_EXCEPTION_NOT_HANDLED');
  assert.equal(facts.dumpType, 'minidump');
  assert.equal(facts.osVersion, '10.0.19045');
});

test('extractStatsFacts rejects unknown sources and bad hashes', () => {
  assert.equal(extractStatsFacts({ source: 'nope' }), null);
  const noHash = extractStatsFacts({ source: 'windbg', fileHash: '../../etc/passwd' });
  assert.equal(noHash.fileHash, undefined);
  assert.equal(noHash.source, 'windbg');
});

test('utcDay is UTC-based', () => {
  // 2026-08-23T23:30Z is still the same UTC day everywhere.
  assert.equal(utcDay(Date.UTC(2026, 7, 23, 23, 30)), '20260823');
  assert.equal(utcDay(Date.UTC(2026, 0, 1)), '20260101');
});

test('buildSnapshot zero-fills window and folds Other', () => {
  const now = Date.UTC(2026, 7, 23, 12);
  const snapshot = buildSnapshot({
    total: '42',
    sources: { windbg: 30, 'ai-fallback': 12 },
    dumpTypes: { kernel: 20, minidump: 22 },
    osVersions: { '10.0.26100': 25, '10.0.19045': 17 },
    stopCodes: { '0x1A': '10', '0x7E': 8, '0x50': 2 },
    stopCodeLabels: { '0x1A': 'MEMORY_MANAGEMENT' },
    buckets: [['AV_nt!ExFreePool', 9], ['ZEROED', 2]],
    modules: [['nvlddmkm.sys', 7], ['ntfs.sys', 3]],
    daily: [['20260822', '5'], ['20260823', '3']],
    lastHour: '4'
  }, { now, windowDays: 90 });

  assert.equal(snapshot.success, true);
  assert.equal(snapshot.totals.analyses, 42);
  assert.equal(snapshot.gauges.lastHour, 4);
  assert.equal(snapshot.gauges.today, 3);
  assert.equal(snapshot.daily.length, 90);
  assert.deepEqual(snapshot.daily[88], { date: '20260822', count: 5 });
  assert.deepEqual(snapshot.daily[89], { date: '20260823', count: 3 });
  // Zero-filled days in between are present with count 0 (missing != absent).
  assert.ok(snapshot.daily.slice(0, 80).every(d => d.count === 0));
  assert.equal(snapshot.topStopCodes.items[0].value, '0x1A');
  assert.equal(snapshot.topStopCodes.items[0].label, 'MEMORY_MANAGEMENT');
  assert.equal(snapshot.topFailureBuckets.items[0].value, 'AV_nt!ExFreePool');
  assert.equal(snapshot.sources.total, 42);
});

test('buildSnapshot is fully deterministic on an empty store', () => {
  const now = Date.UTC(2026, 7, 23, 12);
  const empty = buildSnapshot({}, { now });
  assert.equal(empty.totals.analyses, 0);
  assert.equal(empty.gauges.today, 0);
  assert.equal(empty.daily.filter(d => d.count === 0).length, 90);
  assert.equal(empty.topStopCodes.total, 0);
});
