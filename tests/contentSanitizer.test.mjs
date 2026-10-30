import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { rolldown } from 'rolldown';

// One limit governs how much dump text the fallback prompt carries (issue
// #353): PROCESSING_LIMITS.MAX_STRINGS_LENGTH. The sanitizer used to cut at a
// second constant (SECURITY_CONFIG.processing.maxStringLength, 25,000) before
// the 64 KB MAX_STRINGS_LENGTH could apply.
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));

async function load() {
  const bundle = await rolldown({
    input: 'harness',
    logLevel: 'silent',
    plugins: [{
      name: 'harness',
      resolveId: id => (id === 'harness' ? id : null),
      load: id => (id === 'harness'
        ? `export * from ${JSON.stringify(path.join(root, 'utils/contentSanitizer.ts'))};
export { PROCESSING_LIMITS } from ${JSON.stringify(path.join(root, 'constants.ts'))};
export { SECURITY_CONFIG } from ${JSON.stringify(path.join(root, 'config/security.ts'))};`
        : null),
    }],
  });
  const { output } = await bundle.generate({ format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(output[0].code, 'utf8').toString('base64')}`);
}

test('MAX_STRINGS_LENGTH is the one limit on extracted dump strings (issue #353)', async () => {
  const { sanitizeExtractedContent, PROCESSING_LIMITS, SECURITY_CONFIG } = await load();
  assert.equal(PROCESSING_LIMITS.MAX_STRINGS_LENGTH, 25_000);
  assert.equal('maxStringLength' in SECURITY_CONFIG.processing, false, 'no second, competing limit');
  assert.equal(sanitizeExtractedContent('a'.repeat(100_000)).length, PROCESSING_LIMITS.MAX_STRINGS_LENGTH);
  assert.equal(sanitizeExtractedContent('ab\u0000c\u0001dé'), 'abcd');

  const proxy = await fs.readFile(path.join(root, 'services/geminiProxy.ts'), 'utf8');
  assert.doesNotMatch(proxy, /sanitizeExtractedContent\([^)]*\)\s*\.substring\(/, 'callers rely on the sanitizer limit');
});
