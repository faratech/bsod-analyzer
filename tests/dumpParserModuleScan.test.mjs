import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { rolldown } from 'rolldown';
import { assertScalesLinearly } from './helpers/linearTime.mjs';

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
// browser main thread (issue #153). Each builder gives the 1 MB run at scale 8
// and an eighth of it at scale 1; the test compares the two timings rather
// than a wall-clock budget, which failed on a busy machine.
const CRAFTED_RUNS = {
  'identifier characters': k => 'a'.repeat(125_000 * k),
  'spaces': k => ' '.repeat(125_000 * k),
  'dashes': k => '-'.repeat(125_000 * k),
  'drive prefixes': k => 'C:\\'.repeat(50_000 * k),
  'long path segments': k => `C:\\${'a'.repeat(250)}`.repeat(500 * k),
};

for (const [label, strings] of Object.entries(CRAFTED_RUNS)) {
  test(`module scan stays linear on a 1 MB run of ${label} (issue #153)`, () => {
    assert.ok(strings(8).length >= 1_000_000, label);
    assert.ok(Array.isArray(extractModuleList(kernelDumpBuffer(), strings(8))));
    assertScalesLinearly(label, input => extractModuleList(kernelDumpBuffer(), input), strings);
  });
}
