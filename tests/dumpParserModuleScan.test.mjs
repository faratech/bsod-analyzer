import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { rolldown } from 'rolldown';

// Same loader as dumpParserBugCheck.test.mjs: dumpParser imports sibling
// modules with `.js` specifiers that must resolve back to their `.ts` sources.
async function loadDumpParser() {
  const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  const bundle = await rolldown({
    input: path.join(root, 'utils', 'dumpParser.ts'),
    plugins: [{
      name: 'resolve-ts-from-js-specifier',
      async resolveId(source, importer) {
        if (source.startsWith('.') && source.endsWith('.js') && importer) {
          const candidate = path.resolve(path.dirname(importer), source.slice(0, -3) + '.ts');
          try {
            await fs.access(candidate);
            return candidate;
          } catch {
            return null;
          }
        }
        return null;
      }
    }]
  });
  const { output } = await bundle.generate({ format: 'esm' });
  const encoded = Buffer.from(output[0].code, 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
}

const { extractModuleList } = await loadDumpParser();

// A PAGEDU64 header skips the minidump module stream, so the string scan runs.
function kernelDumpBuffer() {
  const buffer = new ArrayBuffer(4096);
  new Uint8Array(buffer).set(new TextEncoder().encode('PAGEDU64'));
  return buffer;
}

// Each of these runs made at least one of the old unbounded module patterns
// backtrack quadratically (seconds at 20-40k chars, hours at 1 MB) on the
// browser main thread (issue #153).
const CRAFTED_RUNS = {
  'identifier characters': 'a'.repeat(1_000_000),
  'spaces': ' '.repeat(1_000_000),
  'dashes': '-'.repeat(1_000_000),
  'drive prefixes': 'C:\\'.repeat(400_000),
  'long path segments': `C:\\${'a'.repeat(250)}`.repeat(4_000),
};

for (const [label, strings] of Object.entries(CRAFTED_RUNS)) {
  test(`module scan stays linear on a 1 MB run of ${label} (issue #153)`, () => {
    const started = performance.now();
    assert.ok(Array.isArray(extractModuleList(kernelDumpBuffer(), strings)));
    assert.ok(performance.now() - started < 1000, `${label}: the module scan must not backtrack quadratically`);
  });
}
