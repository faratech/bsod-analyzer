import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { transform } from 'rolldown/experimental';

// Leaf .ts module loaded through rolldown's oxc transform (TypeScript 7
// removed transpileModule; see tests/minidumpStreams.test.mjs).
async function loadAnalyzer() {
  const source = await fs.readFile(new URL('../utils/memoryPatternAnalyzer.ts', import.meta.url), 'utf8');
  const result = await transform('memoryPatternAnalyzer.ts', source);
  if (result.errors?.length) {
    throw new Error(`Failed to transform memoryPatternAnalyzer.ts: ${result.errors[0]}`);
  }
  const encoded = Buffer.from(result.code, 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
}

test('a dump saturated with free-fill patterns stays bounded and never throws', async () => {
  const { analyzeMemoryPatterns } = await loadAnalyzer();

  // 5 MB of 0xFEEEFEEE: just under the client's 5 MB skip. The uncapped
  // detectors used to emit hundreds of thousands of indicators and the
  // aggregate push(...spread) threw RangeError, silently disabling the whole
  // analysis (issue #109).
  const words = (5 * 1024 * 1024) / 4;
  const array = new Uint32Array(words);
  array.fill(0xFEEEFEEE);
  const buffer = array.buffer;

  const result = analyzeMemoryPatterns(buffer);
  assert.ok(result.corruption.length <= 6 * 100, `expected bounded indicators, got ${result.corruption.length}`);
  assert.ok(result.summary.length > 0);
});

test('a clean buffer reports no corruption', async () => {
  const { analyzeMemoryPatterns } = await loadAnalyzer();

  // Non-uniform pseudo-data: no guard/free patterns, no plausible RBP chains.
  const array = new Uint32Array(64 * 1024);
  for (let i = 0; i < array.length; i++) array[i] = (i * 2654435761) >>> 0;
  for (let i = 0; i < array.length; i += 2) array[i] = i; // break RBP/ret ranges

  const result = analyzeMemoryPatterns(array.buffer);
  assert.equal(result.corruption.length, 0);
  assert.equal(result.summary, 'No significant memory corruption patterns detected.');
});
