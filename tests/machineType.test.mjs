import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { rolldown } from 'rolldown';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));

// kernelDumpModuleParser has relative `.js` imports, so it is bundled with a
// plugin resolving them back to `.ts` sources.
async function loadTsModule(relativePath) {
  const bundle = await rolldown({
    input: path.join(root, relativePath),
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
  return import(`data:text/javascript;base64,${Buffer.from(output[0].code, 'utf8').toString('base64')}`);
}

// PAGEDU64 large enough for parseKernelDump64 (DUMP_0x2000 block included),
// with MachineImageType at 0x30 and a non-zero CONTEXT area at 0x348.
function buildPagedu64(machineImageType) {
  const buffer = new ArrayBuffer(0x4000);
  const view = new DataView(buffer);
  const sig = 'PAGEDU64';
  for (let i = 0; i < sig.length; i++) view.setUint8(i, sig.charCodeAt(i));
  view.setUint32(0x08, 15, true);
  view.setUint32(0x0C, 26100, true);
  view.setUint32(0x30, machineImageType, true);
  view.setUint32(0x34, 8, true);
  view.setUint32(0x38, 0x1A, true);
  for (let at = 0x348; at < 0x348 + 0x4D0; at += 4) view.setUint32(at, 0x41414141, true);
  return buffer;
}

test('machine type labels follow winnt.h IMAGE_FILE_MACHINE_* values (#284)', async () => {
  const { machineTypeLabel } = await loadTsModule('utils/machineType.ts');
  assert.equal(machineTypeLabel(0x14C), 'x86');
  assert.equal(machineTypeLabel(0x8664), 'x64');
  assert.equal(machineTypeLabel(0xAA64), 'ARM64');
  assert.equal(machineTypeLabel(0x1C4), 'ARM (Thumb-2)');
  // Unknown values are never guessed as 32-bit x86.
  assert.equal(machineTypeLabel(0x1C0), 'unknown (0x1C0)');
  assert.equal(machineTypeLabel(0x5064), 'unknown (0x5064)');
});

test('parseKernelDump64 reports the header MachineImageType, not a constant x64 (#284)', async () => {
  const { parseDumpFile } = await loadTsModule('utils/kernelDumpModuleParser.ts');
  assert.equal(parseDumpFile(buildPagedu64(0x8664))?.architecture, 'x64');
  assert.equal(parseDumpFile(buildPagedu64(0xAA64))?.architecture, 'ARM64');
  assert.equal(parseDumpFile(buildPagedu64(0x1234))?.architecture, 'unknown (0x1234)');
});

test('an ARM64 kernel dump CONTEXT is not parsed with the x86 layout (#284)', async () => {
  const { parseKernelDumpHeader } = await loadTsModule('utils/kernelDumpModuleParser.ts');
  const x64 = parseKernelDumpHeader(buildPagedu64(0x8664));
  assert.ok(x64?.context, 'x64 CONTEXT is parsed');
  const arm64 = parseKernelDumpHeader(buildPagedu64(0xAA64));
  assert.equal(arm64?.machineImageType, 0xAA64);
  assert.equal(arm64?.context, undefined, 'no AMD64/x86 CONTEXT layout fits ARM64');
});

test('the AI prompt labels the machine type through the shared map (#284)', async () => {
  const source = await fs.readFile(path.join(root, 'services/geminiProxy.ts'), 'utf8');
  assert.doesNotMatch(source, /machineImageType === 0x8664 \? 'x64' : 'x86'/);
  assert.match(source, /- Machine Type: \$\{formatMachineType\(structuredInfo\.dumpHeader\.machineImageType\)\}/);
});
