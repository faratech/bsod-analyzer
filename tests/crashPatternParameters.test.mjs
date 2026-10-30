import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rolldown } from 'rolldown';

// Parameter explanations for bug checks, pinned to Microsoft Learn
// (learn.microsoft.com/windows-hardware/drivers/debugger/bug-check-code-reference2)
// and, for 0x139, the FAST_FAIL_* values in the Windows SDK winnt.h.
// crashPatternDatabase.ts has no imports, so a plain rolldown bundle loads it.
async function loadCrashPatterns() {
  const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  const bundle = await rolldown({ input: path.join(root, 'utils/crashPatternDatabase.ts') });
  const { output } = await bundle.generate({ format: 'esm' });
  const encoded = Buffer.from(output[0].code, 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
}

const { getParameterExplanation: explain } = await loadCrashPatterns();
// The decoded value is the explanation's last line (after name and value).
const decoded = (code, parameter, value) => explain(code, parameter, value).split('\n').at(-1);

// Issue #316: since Windows 10 1507, x64/x86 Arg2 is 0 read, 2 write,
// 0x10 execute (Arm and older Windows: 1 write, 8 execute on Arm); Arg4 is
// the page fault type, not a reserved value.
test('0x50 Arg2 decodes the post-1507 access type (#316)', () => {
  assert.equal(decoded(0x50, 2, 0n), 'Access Type: Read');
  assert.equal(decoded(0x50, 2, 2n), 'Access Type: Write');
  assert.equal(decoded(0x50, 2, 0x10n), 'Access Type: Execute');
  assert.doesNotMatch(decoded(0x50, 2, 10n), /Execute/, 'decimal 10 (0xA) is not an access type');
  assert.equal(decoded(0x50, 2, 1n), 'Access Type: Write (Arm, or Windows before 1507)');
  assert.equal(decoded(0x50, 2, 8n), 'Access Type: Execute (Arm)');
  assert.match(explain(0x50, 2, 0n), /0x10/, 'the description lists the documented values');
});

test('0x50 Arg4 is the page fault type (#316)', () => {
  assert.doesNotMatch(explain(0x50, 4, 0n), /Reserved/);
  assert.match(explain(0x50, 4, 0n), /Type of page fault/i);
  assert.match(explain(0x50, 4, 0n), /NONPAGED_BUGCHECK_FREED_PTE/);
  assert.match(explain(0x50, 4, 2n), /NONPAGED_BUGCHECK_NOT_PRESENT_PAGE_TABLE/);
  assert.match(explain(0x50, 4, 3n), /NONPAGED_BUGCHECK_WRONG_SESSION/);
  assert.match(explain(0x50, 4, 4n), /NONPAGED_BUGCHECK_VA_NOT_CANONICAL/);
  assert.match(explain(0x50, 4, 0xFn), /NONPAGED_BUGCHECK_USER_VA_ACCESS_INCONSISTENT/);
});

// utils/dumpValidator.ts validates and summarizes the same parameter for the
// report (createBugCheckInfo): a Windows 10+ x64 write fault (Arg2 = 2) must
// not be flagged invalid or summarized as Execute (#316).
async function loadDumpValidator() {
  const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  const bundle = await rolldown({ input: path.join(root, 'utils/dumpValidator.ts') });
  const { output } = await bundle.generate({ format: 'esm' });
  const encoded = Buffer.from(output[0].code, 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
}

test('dumpValidator accepts and names the post-1507 0x50 access types (#316)', async () => {
  const { validateBugCheckParameters, analyzeBugCheckParameters } = await loadDumpValidator();
  const params = access => [0xFFFF9A0012345000n, access, 0xFFFFF80212345678n, 2n];
  for (const [access, operation] of [[0n, 'Read'], [2n, 'Write'], [0x10n, 'Execute'], [1n, 'Write'], [8n, 'Execute']]) {
    const validation = validateBugCheckParameters(0x50, params(access));
    assert.deepEqual(validation.errors, [], `access 0x${access.toString(16)}`);
    assert.match(analyzeBugCheckParameters(0x50, params(access)).analysis, new RegExp(`Operation: ${operation}\\b`));
  }
  assert.match(validateBugCheckParameters(0x50, params(2n)).description, /P4: .*page fault/i);
});

// Issue #317: 0x139 Arg1 is a FAST_FAIL_* code (winnt.h); Arg2 is the trap
// frame, Arg3 the exception record, Arg4 reserved (Learn, Bug Check 0x139).
test('0x139 Arg1 decodes the FAST_FAIL code with its winnt.h value (#317)', () => {
  const expected = {
    0x00: /FAST_FAIL_LEGACY_GS_VIOLATION.*stack-based buffer is overrun/i,
    0x01: /FAST_FAIL_VTGUARD_CHECK_FAILURE.*virtual function table/i,
    0x02: /FAST_FAIL_STACK_COOKIE_CHECK_FAILURE/,
    0x03: /FAST_FAIL_CORRUPT_LIST_ENTRY.*LIST_ENTRY is corrupted/i,
    0x0A: /FAST_FAIL_GUARD_ICALL_CHECK_FAILURE.*Indirect call guard/i,
    0x0B: /FAST_FAIL_GUARD_WRITE_CHECK_FAILURE.*Write guard/i,
    0x0C: /FAST_FAIL_INVALID_FIBER_SWITCH/,
    0x0D: /FAST_FAIL_INVALID_SET_OF_CONTEXT/,
    0x0E: /FAST_FAIL_INVALID_REFERENCE_COUNT.*reference count/i,
    0x12: /FAST_FAIL_INVALID_JUMP_BUFFER/,
    0x13: /FAST_FAIL_MRDATA_MODIFIED/,
    0x14: /FAST_FAIL_CERTIFICATION_FAILURE.*cryptographic self-test failed/i,
    0x15: /FAST_FAIL_INVALID_EXCEPTION_CHAIN/,
    0x16: /FAST_FAIL_CRYPTO_LIBRARY/,
    0x1A: /FAST_FAIL_UNSAFE_EXTENSION_CALL/,
    0x1B: /FAST_FAIL_DEPRECATED_SERVICE_INVOKED/,
    0x1C: /FAST_FAIL_INVALID_BUFFER_ACCESS/,
    0x1D: /FAST_FAIL_INVALID_BALANCED_TREE.*RTL_BALANCED_NODE RBTree/i,
    0x25: /FAST_FAIL_GUARD_JUMPTABLE/,
    0x26: /FAST_FAIL_INVALID_LONGJUMP_TARGET/,
    0x27: /FAST_FAIL_INVALID_DISPATCH_CONTEXT/
  };
  for (const [value, pattern] of Object.entries(expected)) {
    assert.match(decoded(0x139, 1, BigInt(value)), pattern, `0x${Number(value).toString(16)}`);
  }
  assert.doesNotMatch(decoded(0x139, 1, 0x1Fn), /GUARD_ICALL_CHECK_SUPPRESSED/, 'telemetry code 31 is non-fatal');
});

test('0x139 Arg2-Arg4 are the trap frame, exception record and reserved (#317)', () => {
  assert.match(explain(0x139, 2, 0xFFFFF80212345678n), /trap frame/i);
  assert.match(explain(0x139, 3, 0xFFFFF80212345678n), /exception record/i);
  assert.doesNotMatch(explain(0x139, 3, 0n), /cookie/i);
  assert.match(explain(0x139, 4, 0n), /^Reserved/);
});

test('dumpValidator knows the documented 0x139 types and parameter roles (#317)', async () => {
  const { validateBugCheckParameters } = await loadDumpValidator();
  for (const type of [0x3n, 0xEn, 0x14n, 0x1Dn, 0x26n]) {
    const result = validateBugCheckParameters(0x139, [type, 0xFFFFF80212345678n, 0xFFFFF80212345000n, 0n]);
    assert.deepEqual(result.errors, [], `type 0x${type.toString(16)}`);
  }
  const { description } = validateBugCheckParameters(0x139, [3n, 0xFFFFF80212345678n, 0xFFFFF80212345000n, 0n]);
  assert.match(description, /P2: .*trap frame/i);
  assert.match(description, /P3: .*exception record/i);
  assert.match(description, /P4: Reserved/);
});

// Issue #318: parameter roles from Learn for 0x116, 0x101, 0x133, 0x124.
test('0x116 VIDEO_TDR_FAILURE parameters (#318)', () => {
  assert.match(explain(0x116, 1, 0xFFFFE000C2C404C0n), /TDR recovery context/i);
  assert.match(explain(0x116, 2, 0xFFFFF8016470C14Cn), /responsible device driver module/i);
  assert.match(explain(0x116, 3, 0xC000009An), /error code.*last failed operation/i);
  assert.equal(decoded(0x116, 3, 0xC000009An), 'Status: STATUS_INSUFFICIENT_RESOURCES');
  assert.match(explain(0x116, 4, 4n), /internal context dependent data/i);
  for (const parameter of [1, 2, 3, 4]) {
    assert.doesNotMatch(explain(0x116, parameter, 0n), /Reserved|device object|TDR Recovery Reason/i);
  }
});

test('0x101 CLOCK_WATCHDOG_TIMEOUT parameters (#318)', () => {
  assert.match(explain(0x101, 1, 0x18n), /time-out interval.*clock ticks/i);
  assert.match(explain(0x101, 2, 0n), /always 0/i);
  assert.doesNotMatch(explain(0x101, 2, 0n), /period/i);
  assert.match(explain(0x101, 3, 0xFFFFA0016E9C0180n), /PRCB.*unresponsive processor/i);
  assert.match(explain(0x101, 4, 2n), /index of the hung processor/i);
});

test('0x133 DPC_WATCHDOG_VIOLATION parameters depend on Arg1 (#318)', () => {
  assert.match(explain(0x133, 1, 0n), /type of violation/i);
  assert.match(decoded(0x133, 1, 0n), /single DPC or ISR exceeded its time allotment/i);
  assert.match(decoded(0x133, 1, 1n), /cumulatively.*DISPATCH_LEVEL/i);
  assert.match(explain(0x133, 2, 0x501n), /Arg1 = 0: DPC time count.*Arg1 = 1: watchdog period/i);
  assert.match(explain(0x133, 3, 0x500n), /Arg1 = 0: DPC time allotment.*Arg1 = 1:.*DPC_WATCHDOG_GLOBAL_TRIAGE_BLOCK/i);
  assert.match(explain(0x133, 4, 0n), /Arg1 = 0:.*DPC_WATCHDOG_GLOBAL_TRIAGE_BLOCK.*Arg1 = 1: reserved/i);
});

test('0x124 WHEA_UNCORRECTABLE_ERROR Arg1 is the error source type (#318)', () => {
  assert.match(explain(0x124, 1, 0n), /error source type/i);
  assert.doesNotMatch(explain(0x124, 1, 4n), /bank/i);
  assert.match(decoded(0x124, 1, 0n), /machine check exception/i);
  assert.match(decoded(0x124, 1, 4n), /uncorrectable PCI Express error/i);
  assert.match(decoded(0x124, 1, 0x10n), /device driver error source/i);
  assert.match(decoded(0x124, 1, 0x12n), /Arm SError/i);
  assert.match(explain(0x124, 2, 0xFFFF9A0012345000n), /WHEA_ERROR_RECORD/);
  assert.match(explain(0x124, 3, 0xBE000000n), /MCi_STATUS.*Arg1 = 0.*reserved otherwise/i);
  assert.match(explain(0x124, 4, 0x800400n), /MCi_STATUS.*Arg1 = 0.*reserved otherwise/i);
});
