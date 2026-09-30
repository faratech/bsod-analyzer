import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  DEFAULT_LARGE_DUMP_SAMPLE_BYTES,
  getLargeDumpSampleRanges,
  shouldUseLightweightAiFailover
} from '../shared/windbgFailoverPolicy.js';

test('large dump WinDBG outage uses lightweight AI failover policy', () => {
  const fullLocalLimit = 5 * 1024 * 1024;

  assert.equal(shouldUseLightweightAiFailover(fullLocalLimit, fullLocalLimit), false);
  assert.equal(shouldUseLightweightAiFailover(fullLocalLimit + 1, fullLocalLimit), true);
});

test('large dump failover samples head and tail without reading full file', () => {
  const fileSize = 100 * 1024 * 1024;
  const ranges = getLargeDumpSampleRanges(fileSize);
  const totalBytes = ranges.reduce((sum, range) => sum + range.end - range.start, 0);

  assert.deepEqual(ranges.map(range => range.label), ['head', 'tail']);
  assert.equal(ranges[0].start, 0);
  assert.equal(ranges[1].end, fileSize);
  assert.ok(totalBytes <= DEFAULT_LARGE_DUMP_SAMPLE_BYTES);
  assert.ok(ranges[0].end <= ranges[1].start);
});

test('small dump failover policy keeps full local analysis available', () => {
  const fileSize = 512 * 1024;
  assert.deepEqual(getLargeDumpSampleRanges(fileSize), [
    { label: 'full', start: 0, end: fileSize }
  ]);
});

test('WinDBG-down failover wiring: both failure branches route large dumps to the lightweight AI fallback', async () => {
  // Wiring guard, not a behavioral test: the policy itself is unit-tested above
  // against shared/windbgFailoverPolicy.js. Here we pin that the pipeline still
  // calls the gate and the failover report on BOTH WinDBG failure branches
  // (returned failure and thrown error), so a large dump can never be rejected
  // outright just because WinDBG is down — the failure mode of the legacy
  // "WinDBG analysis is required for large dump files" rejection.
  const source = await fs.readFile(new URL('../services/geminiProxy.ts', import.meta.url), 'utf8');

  assert.match(source, /windbgResult = await analyzeWithWinDBG\(/);
  const gates = [...source.matchAll(/shouldUseLightweightAiFailover\(dumpFile\.file\.size, FULL_LOCAL_ANALYSIS_LIMIT\)/g)];
  assert.equal(gates.length, 2);
  assert.match(source, /generateLargeDumpAiFailoverReport\(dumpFile, fileLabel, windbgFailure\)/);
  assert.doesNotMatch(source, /WinDBG analysis is required for large dump files/);
});
