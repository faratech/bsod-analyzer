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
  return loadTsModule('utils/dumpParser.ts');
}

async function loadTsModule(relativePath) {
  const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
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
  entry(3, 7, 24, 0x700);             // SystemInfoStream (type 7)
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

// 64-bit DUMP_HEADER64 (PAGEDU64): MajorVersion @0x8, MinorVersion (the
// Windows build) @0xC, BugCheckCode @0x38, ULONG64 parameters @0x40-0x58.
function buildPagedu64({ code, build = 22631, params = [0, 0, 0, 0], size = 0x40000 }) {
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  view.setUint32(0x00, 0x45474150, true); // 'PAGE'
  view.setUint32(0x04, 0x34365544, true); // 'DU64'
  view.setUint32(0x08, 15, true);         // MajorVersion
  view.setUint32(0x0C, build, true);      // MinorVersion = build number
  view.setBigUint64(0x10, 0x1ae000n, true); // DirectoryTableBase
  view.setBigUint64(0x18, 0xFFFFE70000000000n, true); // PfnDataBase
  view.setUint32(0x30, 0x8664, true);     // MachineImageType (AMD64)
  view.setUint32(0x34, 8, true);          // NumberProcessors
  view.setUint32(0x38, code, true);       // BugCheckCode
  params.forEach((p, i) => view.setBigUint64(0x40 + i * 8, BigInt(p), true));
  return buffer;
}

function writeAscii(buffer, offset, text) {
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
}

test('PAGEDU64 with a rejected header code returns null, never a code scanned from the header (#188, #225)', async () => {
  const { extractBugCheckInfo } = await loadDumpParser();

  for (const build of [19041, 22631, 26100]) {
    for (const code of [0, 0x10001]) {
      const bugCheck = extractBugCheckInfo(buildPagedu64({ code, build }));
      assert.equal(bugCheck, null, `PAGEDU64 build ${build} header code 0x${code.toString(16)} must not yield a bug check`);
    }
  }
});

test('PAGEDU64 with a valid header code still parses (#188)', async () => {
  const { extractBugCheckInfo } = await loadDumpParser();

  const bugCheck = extractBugCheckInfo(buildPagedu64({
    code: 0xD1,
    params: [0x10n, 2n, 0n, 0xFFFFF80212345678n]
  }));
  assert.ok(bugCheck);
  assert.equal(bugCheck.code, 0xD1);
  assert.equal(bugCheck.name, 'DRIVER_IRQL_NOT_LESS_OR_EQUAL');
  assert.equal(bugCheck.parameter2, 2n);
  assert.equal(bugCheck.parameter4, 0xFFFFF80212345678n);
});

test('PAGEDUMP with header code 0 does not fall through to STOP-text or KiBug scans (#188)', async () => {
  const { extractBugCheckInfo } = await loadDumpParser();

  const buffer = buildPagedump32({ code: 0, params: [0, 0, 0, 0] });
  writeAscii(buffer, 0x1000, '*** STOP: 0x0000007B (0xFFFFF880009A97E8, 0xFFFFFFFFC0000034, 0, 0)');
  writeAscii(buffer, 0x1200, 'KiBug');
  new DataView(buffer).setUint32(0x1208, 0xD1, true);
  new DataView(buffer).setUint32(0x120C, 0x80001000, true);
  assert.equal(extractBugCheckInfo(buffer), null);
});

test('buffers without a structured dump header yield no bug check from text or heuristic scans (#188)', async () => {
  const { extractBugCheckInfo } = await loadDumpParser();

  const textOnly = new ArrayBuffer(0x10000);
  writeAscii(textOnly, 0x800, 'crash log: *** STOP: 0x000000ED BugCheck ED, {1, 2, 3, 4}');
  assert.equal(extractBugCheckInfo(textOnly), null, 'STOP text is not dump-header evidence');

  const rawWords = new ArrayBuffer(0x10000);
  const view = new DataView(rawWords);
  view.setUint32(0x400, 0x3B, true);
  view.setUint32(0x404, 0xC0000005, true);
  view.setUint32(0x408, 0xFFFFF802, true);
  view.setUint32(0x40C, 0x80001000, true);
  assert.equal(extractBugCheckInfo(rawWords), null, 'raw uint32 words are not dump-header evidence');
});

// Writes ExceptionInformation slots past NumberParameters (stale data the
// structured parser must ignore).
function buildMinidumpWithSlots({ numberParameters, slots }) {
  const buffer = buildMinidump({ exceptionCode: 0x80000003 });
  const view = new DataView(buffer);
  view.setUint32(EXCEPTION_STREAM_RVA + 32, numberParameters, true);
  slots.forEach((value, i) => view.setBigUint64(EXCEPTION_STREAM_RVA + 40 + i * 8, BigInt(value), true));
  return buffer;
}

test('user-mode breakpoint minidumps do not fabricate bug checks via a legacy fallback (#189)', async () => {
  const { extractBugCheckInfo } = await loadDumpParser();

  const cases = [
    { numberParameters: 3, slots: [1, 0x7FF6A0002000n, 0x20], why: 'debug-break [1, ptr, len]' },
    { numberParameters: 1, slots: [0x4A61], why: 'one parameter' },
    { numberParameters: 0, slots: [0x3B, 0xC0000005, 0xFFFFF80212345678n, 0xFFFFD0001234n, 0], why: 'stale slots past NumberParameters' },
    { numberParameters: 5, slots: [0x1000000D1n, 0xFFFF9C8000001000n, 2, 0, 0xFFFFF80212345678n], why: '64-bit code slot' }
  ];
  for (const { numberParameters, slots, why } of cases) {
    assert.equal(extractBugCheckInfo(buildMinidumpWithSlots({ numberParameters, slots })), null, why);
  }
});

test('extractDumpHeader recognises the 64-bit PAGEDU64 signature (#190)', async () => {
  const { extractDumpHeader } = await loadDumpParser();

  const header = extractDumpHeader(buildPagedu64({ code: 0xD1, build: 22631 }));
  assert.ok(header, 'PAGEDU64 must produce a dump header');
  assert.equal(header.signature, 'PAGEDU64');
  assert.equal(header.majorVersion, 15);
  assert.equal(header.minorVersion, 22631);
  assert.equal(header.machineImageType, 0x8664);
  assert.equal(header.directoryTableBase, 0x1ae000n);

  const header32 = extractDumpHeader(buildPagedump32({ code: 0x50, params: [0, 0, 0, 0] }));
  assert.equal(header32?.signature, 'PAGEDUMP', 'the 32-bit header still parses');
});

test('kernelDumpModuleParser names PAGEDU64 bug checks from the shared table, never a sentinel "UNKNOWN" (#226)', async () => {
  const { parseDumpFile } = await loadTsModule('utils/kernelDumpModuleParser.ts');
  const { BUG_CHECK_CODES } = await loadDumpParser();

  for (const [code, expected] of [[0x19, 'BAD_POOL_HEADER'], [0xC5, 'DRIVER_CORRUPTED_EXPOOL'],
    [0xEA, 'THREAD_STUCK_IN_DEVICE_DRIVER'], [0x141, 'VIDEO_ENGINE_TIMEOUT_DETECTED'], [0x1A, 'MEMORY_MANAGEMENT']]) {
    const result = parseDumpFile(buildPagedu64({ code, size: 0x4000 }));
    assert.equal(result?.bugCheck.name, expected, `code 0x${code.toString(16)}`);
  }

  // Every code the dumpParser table knows resolves to the same name here.
  const sample = buildPagedu64({ code: 0, size: 0x4000 });
  for (const key of Object.keys(BUG_CHECK_CODES)) {
    new DataView(sample).setUint32(0x38, Number(key), true);
    assert.equal(parseDumpFile(sample)?.bugCheck.name, BUG_CHECK_CODES[key], `code 0x${Number(key).toString(16)}`);
  }

  // A genuinely unknown code must not produce the bare "UNKNOWN" sentinel
  // that wins over the dumpParser name through ??.
  const unknown = parseDumpFile(buildPagedu64({ code: 0x1FF0, size: 0x4000 }));
  assert.notEqual(unknown?.bugCheck.name, 'UNKNOWN');
});

test('BUG_CHECK_CODES names the 0x1CA-0x1F5 codes correctly (#227)', async () => {
  const { BUG_CHECK_CODES } = await loadDumpParser();

  const expected = {
    0x1CA: 'SYNTHETIC_WATCHDOG_TIMEOUT',
    0x1E4: 'VIDEO_DXGKRNL_SYSMM_FATAL_ERROR',
    0x1E9: 'ILLEGAL_ATS_INITIALIZATION',
    0x1EA: 'SECURE_PCI_CONFIG_SPACE_ACCESS_VIOLATION',
    0x1EB: 'DAM_WATCHDOG_TIMEOUT',
    0x1ED: 'HANDLE_ERROR_ON_CRITICAL_THREAD',
    0x1F1: 'KASAN_ENLIGHTENMENT_VIOLATION',
    0x1F2: 'KASAN_ILLEGAL_ACCESS',
    0x1F5: 'APPLICATION_HANG_KERNEL_LIVEDUMP',
    0xC000021A: 'WINLOGON_FATAL_ERROR'
  };
  for (const [code, name] of Object.entries(expected)) {
    assert.equal(BUG_CHECK_CODES[code], name, `0x${Number(code).toString(16).toUpperCase()}`);
  }
});

test('0xA/0xD1 with a non-zero IRQL and 0x50 write access survive parameter validation (#229)', async () => {
  const { extractBugCheckInfo } = await loadDumpParser();

  const cases = [
    { info: [0xD1, 0x10, 2, 0, 0xFFFFF80212345678n], name: 'DRIVER_IRQL_NOT_LESS_OR_EQUAL' },
    { info: [0xA, 0x10, 2, 1, 0xFFFFF80212345678n], name: 'IRQL_NOT_LESS_OR_EQUAL' },
    { info: [0x50, 0xFFFFF80200001000n, 1, 0xFFFFF80212345678n, 2], name: 'PAGE_FAULT_IN_NONPAGED_AREA' },
    { info: [0x50, 0xFFFFF80200001000n, 0, 0xFFFFF80212345678n, 2], name: 'PAGE_FAULT_IN_NONPAGED_AREA' }
  ];
  for (const { info, name } of cases) {
    const bugCheck = extractBugCheckInfo(buildMinidump({ exceptionCode: 0x80000003, exceptionInformation: info }));
    assert.equal(bugCheck?.name, name, `0x${info[0].toString(16)} Arg2=${info[2]}`);
    assert.equal(bugCheck.parameter2, BigInt(info[2]));
  }
});

test('every CRASH_PATTERN_DATABASE entry is keyed under its own bug check code (#228)', async () => {
  const { CRASH_PATTERN_DATABASE } = await loadTsModule('utils/crashPatternDatabase.ts');
  const { BUG_CHECK_CODES } = await loadDumpParser();

  const mismatches = [];
  for (const [key, entry] of Object.entries(CRASH_PATTERN_DATABASE)) {
    const code = Number(key);
    if (entry.bugCheckCode !== code || entry.name !== BUG_CHECK_CODES[code]) {
      mismatches.push(`0x${code.toString(16).toUpperCase()}: ${entry.name} (bugCheckCode 0x${entry.bugCheckCode.toString(16)}, table ${BUG_CHECK_CODES[code]})`);
    }
  }
  assert.deepEqual(mismatches, []);
});

test('CRASH_PATTERN_DATABASE covers 0x3B SYSTEM_SERVICE_EXCEPTION (#228)', async () => {
  const { CRASH_PATTERN_DATABASE, getParameterExplanation } = await loadTsModule('utils/crashPatternDatabase.ts');

  assert.equal(CRASH_PATTERN_DATABASE[0x3B]?.name, 'SYSTEM_SERVICE_EXCEPTION');
  const explanation = getParameterExplanation(0x3B, 1, 0xC0000005n);
  assert.match(explanation, /STATUS_ACCESS_VIOLATION/);
  assert.doesNotMatch(explanation, /Unknown parameter/);
  assert.match(getParameterExplanation(0x3B, 3, 0xFFFFD0001234n), /context record/i);
});

test('0x80000003 minidumps yield documented bug checks outside 0x1-0x1FF (#285)', async () => {
  const { extractBugCheckInfo } = await loadDumpParser();

  const documented = {
    0x1000007E: 'SYSTEM_THREAD_EXCEPTION_NOT_HANDLED_M',
    0x1000007F: 'UNEXPECTED_KERNEL_MODE_TRAP_M',
    0x1000008E: 'KERNEL_MODE_EXCEPTION_NOT_HANDLED_M',
    0x100000EA: 'THREAD_STUCK_IN_DEVICE_DRIVER_M',
    0x100000D6: 'DRIVER_PAGE_FAULT_BEYOND_END_OF_ALLOCATION_M',
    0x356: 'XBOX_ERACTRL_CS_TIMEOUT',
    0x4000008A: 'THREAD_TERMINATE_HELD_MUTEX',
    0x20001: 'HYPERVISOR_ERROR',
    0x21C8: 'MANUALLY_INITIATED_BLACKSCREEN_HOTKEY_LIVE_DUMP',
    0xDEADDEAD: 'MANUALLY_INITIATED_CRASH1'
  };
  for (const [key, name] of Object.entries(documented)) {
    const code = Number(key);
    const bugCheck = extractBugCheckInfo(buildMinidump({
      exceptionCode: 0x80000003,
      exceptionInformation: [code, 0xC0000005, 0xFFFFF80212345678n, 0xFFFF8A0012345000n, 0]
    }));
    assert.equal(bugCheck?.code, code, `0x${code.toString(16)}`);
    assert.equal(bugCheck.name, name);
  }
});

test('0x80000003 minidumps still reject values that are not bug checks (#285)', async () => {
  const { extractBugCheckInfo } = await loadDumpParser();

  // Stream sizes / RVAs / pointers, and an undocumented _M-shaped variant.
  for (const value of [0x400, 0x2000, 0x10000, 0x5A5A5A5A, 0x10000051, 0xFFFFF802]) {
    const bugCheck = extractBugCheckInfo(buildMinidump({
      exceptionCode: 0x80000003,
      exceptionInformation: [value, 0x2, 0x1, 0x89a1d2f33, 0]
    }));
    assert.equal(bugCheck, null, `0x${value.toString(16)}`);
  }
});

test('PAGEDU64 accepts 0x100000D6 and never synthesizes _M names (#285)', async () => {
  const { extractBugCheckInfo, BUG_CHECK_CODES } = await loadDumpParser();

  const bugCheck = extractBugCheckInfo(buildPagedu64({
    code: 0x100000D6,
    params: [0xFFFF8A0012345000n, 0n, 0xFFFFF80212345678n, 0n]
  }));
  assert.equal(bugCheck?.code, 0x100000D6);
  assert.equal(bugCheck.name, 'DRIVER_PAGE_FAULT_BEYOND_END_OF_ALLOCATION_M');
  assert.equal(BUG_CHECK_CODES[0x10000051], undefined);
});

// Issue #319: documented crashes whose parameters fail the per-code gate.
// 0xE2 has no parameters and 0xDEADDEAD four reserved ones (Learn), so they
// arrive all zero; 0x1E Arg1 may be any exception code, including the
// documented 0x80000002 STATUS_DATATYPE_MISALIGNMENT.
test('0x80000003 minidumps keep manually initiated crashes with all-zero parameters (#319)', async () => {
  const { extractBugCheckInfo } = await loadDumpParser();

  for (const [code, name] of [[0xE2, 'MANUALLY_INITIATED_CRASH'], [0xDEADDEAD, 'MANUALLY_INITIATED_CRASH1']]) {
    const bugCheck = extractBugCheckInfo(buildMinidump({
      exceptionCode: 0x80000003,
      exceptionInformation: [code, 0, 0, 0, 0]
    }));
    assert.equal(bugCheck?.code, code, `0x${code.toString(16)}`);
    assert.equal(bugCheck.name, name);
  }
});

test('0x80000003 minidumps keep 0x1E with warning exception codes (#319)', async () => {
  const { extractBugCheckInfo } = await loadDumpParser();

  for (const exception of [0x80000002, 0x80000004, 0x80000003, 0xC0000005]) {
    const bugCheck = extractBugCheckInfo(buildMinidump({
      exceptionCode: 0x80000003,
      exceptionInformation: [0x1E, exception, 0xFFFFF80212345678n, 0, 0xFFFF8A0012345001n]
    }));
    assert.equal(bugCheck?.code, 0x1E, `exception 0x${exception.toString(16)}`);
    assert.equal(bugCheck.parameter1, BigInt(exception));
  }
  // Still rejected: an Arg1 that is not an exception code at all.
  for (const notException of [0, 0x2000, 0x40000000]) {
    const bugCheck = extractBugCheckInfo(buildMinidump({
      exceptionCode: 0x80000003,
      exceptionInformation: [0x1E, notException, 0xFFFFF80212345678n, 0, 0]
    }));
    assert.equal(bugCheck, null, `Arg1 0x${notException.toString(16)}`);
  }
});

test('0x80000003 minidumps keep 0x124 for every documented WHEA error source (#319)', async () => {
  const { extractBugCheckInfo } = await loadDumpParser();

  for (const source of [0x0, 0x4, 0x10, 0x11, 0x12]) {
    const bugCheck = extractBugCheckInfo(buildMinidump({
      exceptionCode: 0x80000003,
      exceptionInformation: [0x124, source, 0xFFFF9A0012345000n, 0, 0]
    }));
    assert.equal(bugCheck?.code, 0x124, `source 0x${source.toString(16)}`);
  }
});
