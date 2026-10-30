import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { transform } from 'rolldown/experimental';

async function load() {
  const source = await fs.readFile(new URL('../utils/formatFileSize.ts', import.meta.url), 'utf8');
  const result = await transform('formatFileSize.ts', source);
  return import(`data:text/javascript;base64,${Buffer.from(result.code, 'utf8').toString('base64')}`);
}

test('formatFileSize picks B, KB, MB or GB so large dumps stay readable (issue #301)', async () => {
  const { formatFileSize } = await load();
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(512), '512 B');
  assert.equal(formatFileSize(1024), '1.0 KB');
  assert.equal(formatFileSize(262144), '256.0 KB');
  assert.equal(formatFileSize(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatFileSize(2 * 1024 * 1024 * 1024), '2.0 GB');
});
