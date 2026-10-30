import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { transform } from 'rolldown/experimental';

// utils/bugCheckCodes.ts is a leaf module (no imports), so a single-file
// transform is enough to load it.
async function loadBugCheckCodes() {
  const url = new URL('../utils/bugCheckCodes.ts', import.meta.url);
  const source = await fs.readFile(url, 'utf8');
  const { code } = await transform('bugCheckCodes.ts', source);
  return import(`data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`);
}

const hex = code => `0x${Number(code).toString(16).toUpperCase()}`;

// Code/name pairs from Microsoft's "Bug check code reference", the "Kernel
// live dump code reference" and, where marked, only the Windows SDK
// bugcodes.h (win32metadata). The table is hand-built, so these pin it to the
// sources instead of comparing it to itself.
const MICROSOFT_PAIRS = {
  // Bug check code reference
  0x11: 'THREAD_NOT_MUTEX_OWNER',
  0x14: 'CREATE_DELETE_LOCK_NOT_LOCKED',
  0x15: 'LAST_CHANCE_CALLED_FROM_KMODE',
  0x16: 'CID_HANDLE_CREATION',
  0x17: 'CID_HANDLE_DELETION',
  0x1B: 'PFN_SHARE_COUNT',
  0x1C: 'PFN_REFERENCE_COUNT',
  0x1D: 'NO_SPIN_LOCK_AVAILABLE',
  0x1F: 'SHARED_RESOURCE_CONV_ERROR',
  0x2D: 'SCSI_DISK_DRIVER_INTERNAL',
  0x4F: 'NDIS_INTERNAL_ERROR',
  0x6B: 'PROCESS1_INITIALIZATION_FAILED',
  0x6C: 'REFMON_INITIALIZATION_FAILED',
  0x7C: 'BUGCODE_NDIS_DRIVER',
  0x82: 'DFS_FILE_SYSTEM',
  0xAD: 'VIDEO_DRIVER_DEBUG_REPORT_REQUEST',
  0xBB: 'NETWORK_BOOT_INITIALIZATION_FAILED',
  0xBD: 'INVALID_HIBERNATED_STATE',
  0xF0: 'STORAGE_MINIPORT_ERROR',
  0xF2: 'HARDWARE_INTERRUPT_STORM',
  0x117: 'VIDEO_TDR_TIMEOUT_DETECTED',
  0x13A: 'KERNEL_MODE_HEAP_CORRUPTION',
  0x13D: 'CRITICAL_INITIALIZATION_FAILURE',
  0x144: 'BUGCODE_USB3_DRIVER',
  0x150: 'TCPIP_AOAC_NIC_ACTIVE_REFERENCE_LEAK',
  0x151: 'UNSUPPORTED_INSTRUCTION_MODE',
  0x17E: 'MICROCODE_REVISION_MISMATCH',
  0x18C: 'HYPERGUARD_VIOLATION',
  0x356: 'XBOX_ERACTRL_CS_TIMEOUT',
  0x20001: 'HYPERVISOR_ERROR',
  0x1000007E: 'SYSTEM_THREAD_EXCEPTION_NOT_HANDLED_M',
  0x1000007F: 'UNEXPECTED_KERNEL_MODE_TRAP_M',
  0x1000008E: 'KERNEL_MODE_EXCEPTION_NOT_HANDLED_M',
  0x100000EA: 'THREAD_STUCK_IN_DEVICE_DRIVER_M',
  0x4000008A: 'THREAD_TERMINATE_HELD_MUTEX',
  0xC000021A: 'WINLOGON_FATAL_ERROR',
  0xDEADDEAD: 'MANUALLY_INITIATED_CRASH1',
  // Kernel live dump code reference
  0x15D: 'SOC_SUBSYSTEM_FAILURE_LIVEDUMP',
  0x15E: 'BUGCODE_NDIS_DRIVER_LIVE_DUMP',
  0x1A5: 'USB_DRIPS_BLOCKER_SURPRISE_REMOVAL_LIVEDUMP',
  0x1B0: 'VIDEO_MINIPORT_FAILED_LIVEDUMP',
  0x1B8: 'VIDEO_MINIPORT_BLACK_SCREEN_LIVEDUMP',
  0x21C8: 'MANUALLY_INITIATED_BLACKSCREEN_HOTKEY_LIVE_DUMP',
  // Windows SDK bugcodes.h only
  0xC0: 'PCI_CONFIG_SPACE_ACCESS_FAILURE',
  0x1E3: 'BREAKAWAY_CABLE_TRANSITION',
  0x1E5: 'DRIVER_VERIFIER_TRACKING_LIVE_DUMP',
  0x1E6: 'CRASHDUMP_WATCHDOG_TIMEOUT',
  0x1E7: 'REGISTRY_LIVE_DUMP',
  0x1E8: 'INVALID_THREAD_AFFINITY_STATE',
  0x1EC: 'HANDLE_LIVE_DUMP',
  0x1F0: 'USB4_HARDWARE_VIOLATION',
  0x1F3: 'IORING',
  0x1F4: 'MDL_CACHE',
  0x1F6: 'MISALIGNED_POINTER_PARAMETER',
  0x1F7: 'MSSECCORE_ASSERTION_FAILURE',
  0x1F8: 'INVALID_MINIMAL_PROCESS_STATE',
  0x1F9: 'PREVIOUS_MODE_MISMATCH',
  0x1FA: 'SMB_SRV_REQUEST_VALIDATION_FAILURE',
  0x1FB: 'IOMMU_INTERRUPT_REMAPPING_FAULT',
  0x1FC: 'WIN32K_CALLOUT_UNREGISTER_FAILED',
  0x1FD: 'HAL_SPE_INTERNAL_ERROR',
  0x1FE: 'SMB_CLIENT_REQUEST_VALIDATION_FAILURE',
  0x200: 'CPU_SCHEDULER_INTERNAL_ERROR',
  0x201: 'PROCESS_TERMINATE_LIKELY_DEADLOCK',
  0x202: 'UNEXPECTED_CODEPATH',
  0x203: 'INVALID_EXTENSION_STATE',
  0x204: 'INVALID_CACHED_SYSTEM_TABLE',
  0x205: 'KCSAN_RACY_ACCESS',
  0x206: 'MULTITIER_MEMORY_DRIVER_INTERNAL',
  0x207: 'FILEINFO_POSSIBLE_DEADLOCK_LIVE_DUMP',
  0x208: 'STORAGE_DRIVER_LIVEDUMP',
  0x20A: 'INTERRUPTS_STATE_MISMATCH',
  0x20B: 'TEST_INITIATED_CRASH',
  0x35A: 'XBOX_XDS_WATCHDOG_TIMEOUT',
  0x35B: 'XBOX_SHUTDOWN_WATCHDOG_TIMEOUT',
  0x35D: 'XBOX_CANNOT_MANAGE_PARTITION_MEMORY',
  0x420: 'XBOX_360_SYSTEM_CRASH_RESERVED',
  0x421: 'XBOX_SECURITY_FAILUE',
  0x422: 'KERNEL_CFG_INIT_FAILURE',
  0x8866: 'SAVER_SICKAPPLICATION',
  0xF000: 'SAVER_UNSPECIFIED',
  0x100000D6: 'DRIVER_PAGE_FAULT_BEYOND_END_OF_ALLOCATION_M',
  0x400000AD: 'VIDEO_DRIVER_DEBUG_REPORT_REQUEST'
};

// Keys with no Microsoft source, or that are not bug checks at all.
const NOT_BUG_CHECKS = [
  0x1AC, 0x1AD, 0x1AE, 0x1EE, 0x1EF, 0x361, 0x362, 0x400, 0x401, 0x402, 0x403,
  0x40003, 0x40010, 0x40030, 0x40050, 0x40052, 0x4008E, 0xC0050,
  0xC0000194, 0xC000026C
];

// The only codes Microsoft gives the same name: 0x400000AD is the
// parameterized form of 0xAD. (The _M family carries its own _M names.)
const SHARED_NAMES = { VIDEO_DRIVER_DEBUG_REPORT_REQUEST: [0xAD, 0x400000AD] };

test('BUG_CHECK_CODES pins code/name pairs to Microsoft references (#282)', async () => {
  const { BUG_CHECK_CODES } = await loadBugCheckCodes();
  for (const [code, name] of Object.entries(MICROSOFT_PAIRS)) {
    assert.equal(BUG_CHECK_CODES[code], name, hex(code));
  }
});

test('BUG_CHECK_CODES has no invented or non-bug-check keys (#282)', async () => {
  const { BUG_CHECK_CODES, bugCheckName } = await loadBugCheckCodes();
  for (const code of NOT_BUG_CHECKS) {
    assert.equal(BUG_CHECK_CODES[code], undefined, hex(code));
    assert.equal(bugCheckName(code), `UNKNOWN_BUG_CHECK_${hex(code)}`);
  }
});

test('every BUG_CHECK_CODES name belongs to one code, except documented aliases (#282)', async () => {
  const { BUG_CHECK_CODES } = await loadBugCheckCodes();
  const byName = new Map();
  for (const [code, name] of Object.entries(BUG_CHECK_CODES)) {
    byName.set(name, [...(byName.get(name) ?? []), Number(code)]);
  }
  for (const [name, codes] of byName) {
    if (codes.length === 1) continue;
    assert.deepEqual(codes.sort((a, b) => a - b), SHARED_NAMES[name] ?? [],
      `${name} is listed under ${codes.map(hex).join(', ')}`);
  }
  // An _M code is the parameterized variant of its base code.
  for (const [code, name] of Object.entries(BUG_CHECK_CODES)) {
    if (!name.endsWith('_M')) continue;
    const base = Number(code) & 0x0FFFFFFF;
    assert.equal(Number(code) & 0xF0000000, 0x10000000, `${name} at ${hex(code)}`);
    assert.equal(`${BUG_CHECK_CODES[base]}_M`, name, `${hex(code)} vs base ${hex(base)}`);
  }
});

test('every NAME (0x..) heading on /documentation matches BUG_CHECK_CODES (#283)', async () => {
  const { BUG_CHECK_CODES } = await loadBugCheckCodes();
  const page = await fs.readFile(new URL('../pages/Documentation.tsx', import.meta.url), 'utf8');
  const headings = [...page.matchAll(/<h4>\s*([A-Z0-9_]+)\s*\((0x[0-9A-Fa-f]+)\)\s*<\/h4>/g)];
  assert.ok(headings.length >= 40, `found only ${headings.length} bug check headings`);
  for (const [, name, code] of headings) {
    // A bug check code is a ULONG: at most eight hex digits.
    assert.ok(code.length <= 10, `${name} has a malformed code ${code}`);
    assert.equal(BUG_CHECK_CODES[parseInt(code, 16)], name, `heading ${name} (${code})`);
  }
  // Every <h4> that carries a code in parentheses must have matched above.
  const coded = [...page.matchAll(/<h4>[^<]*\(0x[^<]*<\/h4>/g)];
  assert.equal(coded.length, headings.length, 'a coded heading is not in NAME (0x..) form');
});
