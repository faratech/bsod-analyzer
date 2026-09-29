import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { rolldown } from 'rolldown';

// kernelDumpModuleParser imports ./contextParser.js, so (like
// tests/dumpParserBugCheck.test.mjs) it is loaded through rolldown bundling
// with a plugin resolving `.js` specifiers back to `.ts` sources.
async function loadKernelDumpModuleParser() {
  const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  const bundle = await rolldown({
    input: path.join(root, 'utils', 'kernelDumpModuleParser.ts'),
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

// Minimal DUMP_HEADER64 (see DUMP_HEADER64_OFFSETS): signature at 0,
// MachineImageType at 0x30, bug check at 0x38, PhysicalMemoryBlock at 0x88.
function buildPagedu64({ numberOfRuns, runCount }) {
  const buffer = new ArrayBuffer(0x2000);
  const view = new DataView(buffer);

  const sig = 'PAGEDU64';
  for (let i = 0; i < sig.length; i++) view.setUint8(i, sig.charCodeAt(i));
  view.setUint32(0x08, 15, true);        // MajorVersion
  view.setUint32(0x0C, 26100, true);     // MinorVersion
  view.setUint32(0x30, 0x8664, true);    // MachineImageType
  view.setUint32(0x34, 16, true);        // NumberProcessors
  view.setUint32(0x38, 0x1A, true);      // BugCheckCode (MEMORY_MANAGEMENT)
  view.setBigUint64(0x40, 0x771n, true); // BugCheckParameter1
  view.setBigUint64(0x48, 0n, true);
  view.setBigUint64(0x50, 0n, true);
  view.setBigUint64(0x58, 0n, true);
  view.setUint32(0x88, numberOfRuns, true);
  view.setBigUint64(0x90, 0x1000n, true); // NumberOfPages

  for (let i = 0; i < runCount; i++) {
    const at = 0x98 + i * 16;
    if (at + 16 > buffer.byteLength) break;
    view.setBigUint64(at, BigInt(i) * 0x100n, true);
    view.setBigUint64(at + 8, 0x100n, true);
  }

  return buffer;
}

test('an implausible PhysicalMemoryBlock run count is rejected without a runaway loop', async () => {
  const { parseKernelDumpHeader } = await loadKernelDumpModuleParser();

  // NumberOfRuns is an unvalidated uint32 from the dump; 0xFFFFFF used to
  // allocate a run object per 16 available bytes (millions on a real file)
  // before anything consumed the result (issue #108).
  const started = Date.now();
  const header = parseKernelDumpHeader(buildPagedu64({ numberOfRuns: 0xFFFFFF, runCount: 0 }));
  const elapsed = Date.now() - started;

  assert.ok(header, 'the header itself should still parse');
  assert.equal(header.bugCheckCode, 0x1A);
  assert.equal(header.physicalMemoryDescriptor.runs.length, 0, 'implausible run count must not allocate runs');
  assert.ok(elapsed < 1000, `header parse took ${elapsed}ms`);
});

test('a plausible run count parses (and stays bounded at the cap)', async () => {
  const { parseKernelDumpHeader } = await loadKernelDumpModuleParser();

  const header = parseKernelDumpHeader(buildPagedu64({ numberOfRuns: 3, runCount: 3 }));
  assert.equal(header.physicalMemoryDescriptor.runs.length, 3);
  assert.equal(header.physicalMemoryDescriptor.runs[0].basePage, 0n);
  assert.equal(header.physicalMemoryDescriptor.runs[2].pageCount, 0x100n);

  // Even a hostile count at the trust boundary cannot allocate more than the
  // parsed-run cap.
  const bounded = parseKernelDumpHeader(buildPagedu64({ numberOfRuns: 0x10000, runCount: 4096 }));
  assert.ok(bounded.physicalMemoryDescriptor.runs.length <= 4096);
});
