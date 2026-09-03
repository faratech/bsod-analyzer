import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { rolldown } from 'rolldown';

// TypeScript 7 removed transpileModule from its JS API, so tests load .ts
// sources through rolldown (already a vite dependency). dumpParser pulls in
// minidumpStreams/dumpValidator/kernelDumpModuleParser, so it needs bundling,
// and its `.js`-suffixed relative imports must resolve back to `.ts` sources.
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

const STREAM_DIRECTORY_RVA = 0x20;
const EXCEPTION_STREAM_RVA = 0x200;
const MEMORY_LIST_RVA = 0x400;
const STREAM_COUNT = 13;

// Synthetic but realistic 8 KB MDMP: header, 13-entry stream directory at
// 0x20, an ExceptionStream at 0x200 and a MemoryListStream at 0x400.
// Entry 8 lands exactly at 0x80 — the first offset the removed fixed-offset
// scans used to read as a "bug check code" (entry 8's StreamType).
function buildMinidump({ exceptionCode, exceptionInformation = [] }) {
  const buffer = new ArrayBuffer(0x2000);
  const view = new DataView(buffer);

  view.setUint32(0x00, 0x504d444d, true); // 'MDMP'
  view.setUint32(0x04, 4289989932, true); // version
  view.setUint32(0x08, STREAM_COUNT, true);
  view.setUint32(0x0c, STREAM_DIRECTORY_RVA, true);

  const entry = (index, type, dataSize, rva) => {
    const at = STREAM_DIRECTORY_RVA + index * 12;
    view.setUint32(at, type, true);
    view.setUint32(at + 4, dataSize, true);
    view.setUint32(at + 8, rva, true);
  };

  const ExceptionStream = 6;
  const MemoryListStream = 5;
  entry(0, 3, 2000, 0x600);           // ThreadListStream
  entry(1, MemoryListStream, 16, MEMORY_LIST_RVA);
  entry(2, 4, 0, 0);                  // ModuleListStream (empty)
  entry(3, 7, 24, 0x700);             // MiscInfoStream
  entry(4, ExceptionStream, 168, EXCEPTION_STREAM_RVA);
  entry(5, 9, 0, 0);
  entry(6, 15, 0, 0);
  entry(7, 16, 0, 0);
  // Entry 8 sits at 0x80: StreamType 0x10, DataSize 0x100, Rva 0x400 — the
  // exact bytes the old fixed-offset scan fabricated into STOP 0x10 with
  // parameters 256/1024/…
  entry(8, 0x10, 0x100, 0x400);
  entry(9, 18, 0, 0);
  entry(10, 22, 0, 0);
  entry(11, 23, 0, 0);
  entry(12, 24, 0, 0);

  // MINIDUMP_EXCEPTION_STREAM: ThreadId (4), alignment (4), then
  // MINIDUMP_EXCEPTION: ExceptionCode at rva+8, NumberParameters at rva+32,
  // ExceptionInformation[0..] at rva+40 (8 bytes each).
  view.setUint32(EXCEPTION_STREAM_RVA, 4321, true);       // ThreadId
  view.setUint32(EXCEPTION_STREAM_RVA + 8, exceptionCode, true);
  view.setUint32(EXCEPTION_STREAM_RVA + 32, exceptionInformation.length, true); // NumberParameters
  exceptionInformation.forEach((value, i) => {
    view.setBigUint64(EXCEPTION_STREAM_RVA + 40 + i * 8, BigInt(value), true);
  });

  // MemoryListStream payload: zero memories.
  view.setUint32(MEMORY_LIST_RVA, 0, true);

  return buffer;
}

test('minidump STOP codes are not fabricated from stream directory bytes', async () => {
  const { extractBugCheckInfo } = await loadDumpParser();

  const bugCheck = extractBugCheckInfo(buildMinidump({
    exceptionCode: 0xc0000005,          // ACCESS_VIOLATION user-mode exception
    exceptionInformation: [0, 0x10]
  }));

  // The removed heuristics returned code 0x10 SPIN_LOCK_NOT_OWNED with
  // stream DataSize/Rva values as parameters for this input.
  assert.equal(bugCheck, null);
});

test('kernel-crash minidump (0x80000003 BREAKPOINT) still yields its real STOP code', async () => {
  const { extractBugCheckInfo } = await loadDumpParser();

  const bugCheck = extractBugCheckInfo(buildMinidump({
    exceptionCode: 0x80000003,          // BREAKPOINT — kernel crash convention
    exceptionInformation: [0x1a, 0x2, 0x1, 0x89a1d2f33, 0] // MEMORY_MANAGEMENT + params
  }));

  assert.ok(bugCheck, 'expected the documented exception-stream bug check');
  assert.equal(bugCheck.code, 0x1a);
  assert.equal(bugCheck.name, 'MEMORY_MANAGEMENT');
  assert.equal(bugCheck.parameter1, 2n);
});
