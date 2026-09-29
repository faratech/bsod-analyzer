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

// 32-bit DUMP_HEADER (PAGEDUMP): BugCheckCode @0x28, ULONG parameters
// @0x2C-0x38, VersionUser ASCII text @0x3C. The old code read the code from
// 0x40 — inside that text — and fell through to the unanchored scans.
function buildPagedump32({ code, params }) {
  const buffer = new ArrayBuffer(0x2000);
  const view = new DataView(buffer);

  view.setUint32(0x00, 0x45474150, true); // 'PAGE'
  view.setUint32(0x04, 0x504D5544, true); // 'DUMP'
  view.setUint32(0x08, 15, true);         // MajorVersion
  view.setUint32(0x0C, 7601, true);       // MinorVersion
  view.setUint32(0x20, 0x014C, true);     // MachineImageType (I386)
  view.setUint32(0x24, 2, true);          // NumberProcessors
  view.setUint32(0x28, code, true);       // BugCheckCode
  params.forEach((p, i) => view.setUint32(0x2C + i * 4, p, true));
  // VersionUser text where the old 0x40 read looked.
  const text = 'Service Pack 2';
  for (let i = 0; i < text.length; i++) view.setUint8(0x3C + i, text.charCodeAt(i));

  return buffer;
}

test('32-bit PAGEDUMP reads BugCheckCode from 0x28, not the VersionUser text at 0x40', async () => {
  const { extractBugCheckInfo } = await loadDumpParser();

  const bugCheck = extractBugCheckInfo(buildPagedump32({
    code: 0x50,                           // PAGE_FAULT_IN_NONPAGED_AREA
    params: [0x0a2b0060, 1, 0x82a5b1d3, 0]
  }));

  assert.ok(bugCheck, 'expected the structured header bug check');
  assert.equal(bugCheck.code, 0x50);
  assert.equal(bugCheck.name, 'PAGE_FAULT_IN_NONPAGED_AREA');
  assert.equal(bugCheck.parameter1, 0x0a2b0060n);
  assert.equal(bugCheck.parameter2, 1n);
  assert.equal(bugCheck.parameter3, 0x82a5b1d3n);
  assert.equal(bugCheck.parameter4, 0n);
});

test('minidump STOP text in process memory does not fabricate a bug check', async () => {
  const { extractBugCheckInfo } = await loadDumpParser();

  const buffer = buildMinidump({
    exceptionCode: 0xc0000005,          // ordinary user-mode access violation
    exceptionInformation: [0, 0x10]
  });
  // A crash-log fragment reachable in the first 64KB — process memory, a
  // comment stream, etc. The text/KiBug scans used to accept it as evidence.
  const text = 'crash log says *** STOP: 0x000000ED happened; BugCheck ED, {1,2,3,4}';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < text.length; i++) bytes[0x1000 + i] = text.charCodeAt(i);

  const bugCheck = extractBugCheckInfo(buffer);
  assert.equal(bugCheck, null, 'a user-mode MDMP has no bug check beyond the exception-stream convention');
});

// EXCEPTION_RECORD64: ExceptionCode@+0, ExceptionFlags@+4, link@+8,
// ExceptionAddress@+16, NumberParameters@+24, ExceptionInformation[0]@+32, [1]@+40.
function writeExceptionRecord64(buffer, offset, { code, address, info0, info1 }) {
  const view = new DataView(buffer);
  view.setUint32(offset, code, true);
  view.setUint32(offset + 4, 0, true);                    // ExceptionFlags
  view.setBigUint64(offset + 8, 0n, true);                // ExceptionRecord link
  view.setBigUint64(offset + 16, address, true);          // ExceptionAddress
  view.setUint32(offset + 24, 2, true);                   // NumberParameters
  view.setUint32(offset + 28, 0, true);                   // alignment
  view.setBigUint64(offset + 32, info0, true);
  view.setBigUint64(offset + 40, info1, true);
}

test('extractExceptionInfo accepts a genuine kernel EXCEPTION_RECORD64', async () => {
  const { extractExceptionInfo } = await loadDumpParser();

  const buffer = new ArrayBuffer(0x1000);
  writeExceptionRecord64(buffer, 0xF00, {
    code: 0x80000003,
    address: 0xFFFFF802ABCDEF00n,       // kernel text — rejected by the old check
    info0: 0x10n,
    info1: 0n
  });

  const info = extractExceptionInfo(buffer);
  assert.ok(info, 'expected the kernel-space record to be accepted');
  assert.equal(info.code, 0x80000003);
  assert.equal(info.address, 0xFFFFF802ABCDEF00n);
  assert.equal(info.parameter1, 0x10n);
});

test('extractExceptionInfo parses a genuine 32-bit EXCEPTION_RECORD (x86 dump)', async () => {
  const { extractExceptionInfo } = await loadDumpParser();

  // A 32-bit record whose 64-bit interpretation is implausible: the 64-bit
  // ExceptionAddress slot (offset +16) stays zero here, while the 32-bit
  // layout's ExceptionAddress at +12 holds a real user-space address. The old
  // code only reached its 32-bit branch from an out-of-bounds throw, so this
  // record could never parse correctly.
  const buffer = new ArrayBuffer(0x100);
  const view = new DataView(buffer);
  view.setUint32(0x40, 0xC0000005, true);       // ExceptionCode
  view.setUint32(0x40 + 12, 0x00ABCDEF, true);  // ExceptionAddress (32-bit layout)

  const info = extractExceptionInfo(buffer);
  assert.ok(info, 'expected the 32-bit record to be found');
  assert.equal(info.code, 0xC0000005);
  assert.equal(info.address, 0x00ABCDEFn);
});

test('extractExceptionInfo tolerates an exception hit near the buffer tail', async () => {
  const { extractExceptionInfo } = await loadDumpParser();

  // A code word at the largest offset the OLD loop bound still reached
  // (searchLimit - 36): the old 64-bit read went out of bounds there, the
  // catch fell into the unvalidated 32-bit path, and a fabricated record was
  // returned from the all-zero tail. The fixed bound (i + 48 <= searchLimit)
  // never examines the offset at all (issue #110).
  const buffer = new ArrayBuffer(64);
  const view = new DataView(buffer);
  view.setUint32(28, 0xC0000005, true);

  const info = extractExceptionInfo(buffer);
  assert.equal(info, null);
});
