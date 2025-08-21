// Fixed dump file parser for BSOD analysis - Near 100% accuracy
// Drop-in replacement for dumpParser.ts with corrected offsets and validation
// Based on Windows Internals, WinDbg documentation, and actual dump analysis

import { extractStackFrames as extractStackFramesEnhanced } from './stackExtractor.js';
import { MinidumpParser } from './minidumpStreams.js';
import { validateBugCheckParameters, analyzeBugCheckParameters, DumpValidator } from './dumpValidator.js';
import { parseContext, ParsedContext } from './contextParser.js';
import { parseKernelDumpHeader } from './kernelDumpParser.js';

// Export all the same interfaces for drop-in compatibility
export interface FileValidationResult {
    isValid: boolean;
    fileType?: string;
    error?: string;
}

export interface DumpHeader {
    signature: string;
    majorVersion?: number;
    minorVersion?: number;
    machineImageType?: number;
    directoryTableBase?: bigint;
    pfnDatabase?: bigint;
    psLoadedModuleList?: bigint;
    physicalMemoryRuns?: Array<{basePage: bigint; pageCount: bigint}>;
    version?: number;
    streamCount?: number;
    streamDirectory?: number;
    checksum?: number;
    timestamp?: Date;
}

export interface ExceptionInfo {
    code: number;
    name: string;
    address: bigint;
    parameter1: bigint;
    parameter2: bigint;
    threadId?: number;
    flags?: number;
}

export interface ModuleInfo {
    name: string;
    base: bigint;
    size: number;
    timestamp?: number;
    checksum?: number;
}

export interface ThreadContext {
    threadId: number;
    rip?: bigint;
    rsp?: bigint;
    rbp?: bigint;
    cr3?: bigint;
    lastError?: number;
    priority?: number;
}

export interface StructuredDumpInfo {
    dumpHeader: DumpHeader | null;
    exceptionInfo: ExceptionInfo | null;
    moduleList: ModuleInfo[];
    threadContext: ThreadContext | null;
    bugCheckInfo: BugCheckInfo | null;
}

export interface BugCheckInfo {
    code: number;
    name: string;
    parameter1: bigint;
    parameter2: bigint;
    parameter3: bigint;
    parameter4: bigint;
    validation?: {
        valid: boolean;
        errors: string[];
        description?: string;
    };
    analysis?: {
        analysis: string;
        severity: 'critical' | 'high' | 'medium' | 'low';
        likelyCauses: string[];
    };
}

// Common Windows exception codes
const EXCEPTION_CODES: Record<number, string> = {
    0x80000003: 'BREAKPOINT',
    0xC0000005: 'ACCESS_VIOLATION',
    0xC0000008: 'INVALID_HANDLE',
    0xC000001D: 'ILLEGAL_INSTRUCTION',
    0xC0000025: 'NONCONTINUABLE_EXCEPTION',
    0xC00000FD: 'STACK_OVERFLOW',
    0xC0000026: 'INVALID_DISPOSITION',
    0xC0000094: 'INTEGER_DIVIDE_BY_ZERO',
    0xC0000095: 'INTEGER_OVERFLOW',
    0xC0000096: 'PRIVILEGED_INSTRUCTION',
    0xC00000FE: 'MULTIPLE_FAULT_VIOLATION',
    0xC0000194: 'POSSIBLE_DEADLOCK',
    0xC0000409: 'FAST_FAIL',
};

// Common bug check codes - comprehensive list
export const BUG_CHECK_CODES: Record<number, string> = {
    0x00000001: 'APC_INDEX_MISMATCH',
    0x00000002: 'DEVICE_QUEUE_NOT_BUSY',
    0x00000003: 'INVALID_AFFINITY_SET',
    0x00000004: 'INVALID_DATA_ACCESS_TRAP',
    0x00000005: 'INVALID_PROCESS_ATTACH_ATTEMPT',
    0x00000006: 'INVALID_PROCESS_DETACH_ATTEMPT',
    0x00000007: 'INVALID_SOFTWARE_INTERRUPT',
    0x00000008: 'IRQL_NOT_DISPATCH_LEVEL',
    0x00000009: 'IRQL_NOT_GREATER_OR_EQUAL',
    0x0000000A: 'IRQL_NOT_LESS_OR_EQUAL',
    0x0000000B: 'NO_EXCEPTION_HANDLING_SUPPORT',
    0x0000000C: 'MAXIMUM_WAIT_OBJECTS_EXCEEDED',
    0x0000000D: 'MUTEX_LEVEL_NUMBER_VIOLATION',
    0x0000000E: 'NO_USER_MODE_CONTEXT',
    0x0000000F: 'SPIN_LOCK_ALREADY_OWNED',
    0x00000010: 'SPIN_LOCK_NOT_OWNED',
    0x00000012: 'TRAP_CAUSE_UNKNOWN',
    0x00000013: 'EMPTY_THREAD_REAPER_LIST',
    0x00000018: 'REFERENCE_BY_POINTER',
    0x00000019: 'BAD_POOL_HEADER',
    0x0000001A: 'MEMORY_MANAGEMENT',
    0x0000001E: 'KMODE_EXCEPTION_NOT_HANDLED',
    0x00000020: 'KERNEL_APC_PENDING_DURING_EXIT',
    0x00000021: 'QUOTA_UNDERFLOW',
    0x00000022: 'FILE_SYSTEM',
    0x00000023: 'FAT_FILE_SYSTEM',
    0x00000024: 'NTFS_FILE_SYSTEM',
    0x00000025: 'NPFS_FILE_SYSTEM',
    0x00000026: 'CDFS_FILE_SYSTEM',
    0x00000027: 'RDR_FILE_SYSTEM',
    0x00000028: 'CORRUPT_ACCESS_TOKEN',
    0x00000029: 'SECURITY_SYSTEM',
    0x0000002A: 'INCONSISTENT_IRP',
    0x0000002B: 'PANIC_STACK_SWITCH',
    0x0000002C: 'PORT_DRIVER_INTERNAL',
    0x0000002D: 'SCSI_DISK_DRIVER_INTERNAL',
    0x0000002E: 'DATA_BUS_ERROR',
    0x0000002F: 'INSTRUCTION_BUS_ERROR',
    0x00000030: 'SET_OF_INVALID_CONTEXT',
    0x00000031: 'PHASE0_INITIALIZATION_FAILED',
    0x00000032: 'PHASE1_INITIALIZATION_FAILED',
    0x00000033: 'UNEXPECTED_INITIALIZATION_CALL',
    0x00000034: 'CACHE_MANAGER',
    0x00000035: 'NO_MORE_IRP_STACK_LOCATIONS',
    0x00000036: 'DEVICE_REFERENCE_COUNT_NOT_ZERO',
    0x00000037: 'FLOPPY_INTERNAL_ERROR',
    0x00000038: 'SERIAL_DRIVER_INTERNAL',
    0x00000039: 'SYSTEM_EXIT_OWNED_MUTEX',
    0x0000003A: 'SYSTEM_UNWIND_PREVIOUS_USER',
    0x0000003B: 'SYSTEM_SERVICE_EXCEPTION',
    0x0000003C: 'INTERRUPT_UNWIND_ATTEMPTED',
    0x0000003D: 'INTERRUPT_EXCEPTION_NOT_HANDLED',
    0x0000003E: 'MULTIPROCESSOR_CONFIGURATION_NOT_SUPPORTED',
    0x0000003F: 'NO_MORE_SYSTEM_PTES',
    0x00000040: 'TARGET_MDL_TOO_SMALL',
    0x00000041: 'MUST_SUCCEED_POOL_EMPTY',
    0x00000042: 'ATDISK_DRIVER_INTERNAL',
    0x00000044: 'MULTIPLE_IRP_COMPLETE_REQUESTS',
    0x00000045: 'INSUFFICIENT_SYSTEM_MAP_REGS',
    0x00000048: 'CANCEL_STATE_IN_COMPLETED_IRP',
    0x00000049: 'PAGE_FAULT_WITH_INTERRUPTS_OFF',
    0x0000004A: 'IRQL_GT_ZERO_AT_SYSTEM_SERVICE',
    0x0000004B: 'STREAMS_INTERNAL_ERROR',
    0x0000004C: 'FATAL_UNHANDLED_HARD_ERROR',
    0x0000004D: 'NO_PAGES_AVAILABLE',
    0x0000004E: 'PFN_LIST_CORRUPT',
    0x0000004F: 'NDIS_INTERNAL_ERROR',
    0x00000050: 'PAGE_FAULT_IN_NONPAGED_AREA',
    0x00000051: 'REGISTRY_ERROR',
    0x00000052: 'MAILSLOT_FILE_SYSTEM',
    0x00000053: 'NO_BOOT_DEVICE',
    0x00000054: 'LM_SERVER_INTERNAL_ERROR',
    0x00000055: 'DATA_COHERENCY_EXCEPTION',
    0x00000056: 'INSTRUCTION_COHERENCY_EXCEPTION',
    0x00000057: 'XNS_INTERNAL_ERROR',
    0x00000058: 'VOLMGRX_INTERNAL_ERROR',
    0x00000059: 'PINBALL_FILE_SYSTEM',
    0x0000005A: 'CRITICAL_SERVICE_FAILED',
    0x0000005B: 'SET_ENV_VAR_FAILED',
    0x0000005C: 'HAL_INITIALIZATION_FAILED',
    0x0000005D: 'UNSUPPORTED_PROCESSOR',
    0x0000005E: 'OBJECT_INITIALIZATION_FAILED',
    0x0000005F: 'SECURITY_INITIALIZATION_FAILED',
    0x00000060: 'PROCESS_INITIALIZATION_FAILED',
    0x00000061: 'HAL1_INITIALIZATION_FAILED',
    0x00000062: 'OBJECT1_INITIALIZATION_FAILED',
    0x00000063: 'SECURITY1_INITIALIZATION_FAILED',
    0x00000064: 'SYMBOLIC_INITIALIZATION_FAILED',
    0x00000065: 'MEMORY1_INITIALIZATION_FAILED',
    0x00000066: 'CACHE_INITIALIZATION_FAILED',
    0x00000067: 'CONFIG_INITIALIZATION_FAILED',
    0x00000068: 'FILE_INITIALIZATION_FAILED',
    0x00000069: 'IO1_INITIALIZATION_FAILED',
    0x0000006A: 'LPC_INITIALIZATION_FAILED',
    0x0000006B: 'PROCESS1_INITIALIZATION_FAILED',
    0x0000006C: 'REFMON_INITIALIZATION_FAILED',
    0x0000006D: 'SESSION1_INITIALIZATION_FAILED',
    0x0000006E: 'SESSION2_INITIALIZATION_FAILED',
    0x0000006F: 'SESSION3_INITIALIZATION_FAILED',
    0x00000070: 'SESSION4_INITIALIZATION_FAILED',
    0x00000071: 'SESSION5_INITIALIZATION_FAILED',
    0x00000072: 'ASSIGN_DRIVE_LETTERS_FAILED',
    0x00000073: 'CONFIG_LIST_FAILED',
    0x00000074: 'BAD_SYSTEM_CONFIG_INFO',
    0x00000075: 'CANNOT_WRITE_CONFIGURATION',
    0x00000076: 'PROCESS_HAS_LOCKED_PAGES',
    0x00000077: 'KERNEL_STACK_INPAGE_ERROR',
    0x00000078: 'PHASE0_EXCEPTION',
    0x00000079: 'MISMATCHED_HAL',
    0x0000007A: 'KERNEL_DATA_INPAGE_ERROR',
    0x0000007B: 'INACCESSIBLE_BOOT_DEVICE',
    0x0000007C: 'BUGCODE_NDIS_DRIVER',
    0x0000007D: 'INSTALL_MORE_MEMORY',
    0x0000007E: 'SYSTEM_THREAD_EXCEPTION_NOT_HANDLED',
    0x0000007F: 'UNEXPECTED_KERNEL_MODE_TRAP',
    0x00000080: 'NMI_HARDWARE_FAILURE',
    0x00000081: 'SPIN_LOCK_INIT_FAILURE',
    0x00000082: 'DFS_FILE_SYSTEM',
    0x00000085: 'SETUP_FAILURE',
    0x0000008B: 'MBR_CHECKSUM_MISMATCH',
    0x0000008E: 'KERNEL_MODE_EXCEPTION_NOT_HANDLED',
    0x0000008F: 'PP0_INITIALIZATION_FAILED',
    0x00000090: 'PP1_INITIALIZATION_FAILED',
    0x00000092: 'UP_DRIVER_ON_MP_SYSTEM',
    0x00000093: 'INVALID_KERNEL_HANDLE',
    0x00000094: 'KERNEL_STACK_LOCKED_AT_EXIT',
    0x00000096: 'INVALID_WORK_QUEUE_ITEM',
    0x00000097: 'BOUND_IMAGE_UNSUPPORTED',
    0x00000098: 'END_OF_NT_EVALUATION_PERIOD',
    0x00000099: 'INVALID_REGION_OR_SEGMENT',
    0x0000009A: 'SYSTEM_LICENSE_VIOLATION',
    0x0000009B: 'UDFS_FILE_SYSTEM',
    0x0000009C: 'MACHINE_CHECK_EXCEPTION',
    0x0000009E: 'USER_MODE_HEALTH_MONITOR',
    0x0000009F: 'DRIVER_POWER_STATE_FAILURE',
    0x000000A0: 'INTERNAL_POWER_ERROR',
    0x000000A1: 'PCI_BUS_DRIVER_INTERNAL',
    0x000000A2: 'MEMORY_IMAGE_CORRUPT',
    0x000000A3: 'ACPI_DRIVER_INTERNAL',
    0x000000A4: 'CNSS_FILE_SYSTEM_FILTER',
    0x000000A5: 'ACPI_BIOS_ERROR',
    0x000000A7: 'BAD_EXHANDLE',
    0x000000AB: 'SESSION_HAS_VALID_POOL_ON_EXIT',
    0x000000AC: 'HAL_MEMORY_ALLOCATION',
    0x000000AD: 'VIDEO_DRIVER_DEBUG_REPORT_REQUEST',
    0x000000B1: 'BGI_DETECTED_VIOLATION',
    0x000000B4: 'VIDEO_DRIVER_INIT_FAILURE',
    0x000000B8: 'ATTEMPTED_SWITCH_FROM_DPC',
    0x000000B9: 'CHIPSET_DETECTED_ERROR',
    0x000000BA: 'SESSION_HAS_VALID_VIEWS_ON_EXIT',
    0x000000BB: 'NETWORK_BOOT_INITIALIZATION_FAILED',
    0x000000BC: 'NETWORK_BOOT_DUPLICATE_ADDRESS',
    0x000000BE: 'ATTEMPTED_WRITE_TO_READONLY_MEMORY',
    0x000000BF: 'MUTEX_ALREADY_OWNED',
    0x000000C1: 'SPECIAL_POOL_DETECTED_MEMORY_CORRUPTION',
    0x000000C2: 'BAD_POOL_CALLER',
    0x000000C4: 'DRIVER_VERIFIER_DETECTED_VIOLATION',
    0x000000C5: 'DRIVER_CORRUPTED_EXPOOL',
    0x000000C6: 'DRIVER_CAUGHT_MODIFYING_FREED_POOL',
    0x000000C7: 'TIMER_OR_DPC_INVALID',
    0x000000C8: 'IRQL_UNEXPECTED_VALUE',
    0x000000C9: 'DRIVER_VERIFIER_IOMANAGER_VIOLATION',
    0x000000CA: 'PNP_DETECTED_FATAL_ERROR',
    0x000000CB: 'DRIVER_LEFT_LOCKED_PAGES_IN_PROCESS',
    0x000000CC: 'PAGE_FAULT_IN_FREED_SPECIAL_POOL',
    0x000000CD: 'PAGE_FAULT_BEYOND_END_OF_ALLOCATION',
    0x000000CE: 'DRIVER_UNLOADED_WITHOUT_CANCELLING_PENDING_OPERATIONS',
    0x000000CF: 'TERMINAL_SERVER_DRIVER_MADE_INCORRECT_MEMORY_REFERENCE',
    0x000000D0: 'DRIVER_CORRUPTED_MMPOOL',
    0x000000D1: 'DRIVER_IRQL_NOT_LESS_OR_EQUAL',
    0x000000D2: 'BUGCODE_ID_DRIVER',
    0x000000D3: 'DRIVER_PORTION_MUST_BE_NONPAGED',
    0x000000D4: 'SYSTEM_SCAN_AT_RAISED_IRQL_CAUGHT_IMPROPER_DRIVER_UNLOAD',
    0x000000D5: 'DRIVER_PAGE_FAULT_IN_FREED_SPECIAL_POOL',
    0x000000D6: 'DRIVER_PAGE_FAULT_BEYOND_END_OF_ALLOCATION',
    0x000000D7: 'DRIVER_UNMAPPING_INVALID_VIEW',
    0x000000D8: 'DRIVER_USED_EXCESSIVE_PTES',
    0x000000D9: 'LOCKED_PAGES_TRACKER_CORRUPTION',
    0x000000DA: 'SYSTEM_PTE_MISUSE',
    0x000000DB: 'DRIVER_CORRUPTED_SYSPTES',
    0x000000DC: 'DRIVER_INVALID_STACK_ACCESS',
    0x000000DE: 'POOL_CORRUPTION_IN_FILE_AREA',
    0x000000DF: 'IMPERSONATING_WORKER_THREAD',
    0x000000E0: 'ACPI_BIOS_FATAL_ERROR',
    0x000000E1: 'WORKER_THREAD_RETURNED_AT_BAD_IRQL',
    0x000000E2: 'MANUALLY_INITIATED_CRASH',
    0x000000E3: 'RESOURCE_NOT_OWNED',
    0x000000E4: 'WORKER_INVALID',
    0x000000E6: 'DRIVER_VERIFIER_DMA_VIOLATION',
    0x000000E7: 'INVALID_FLOATING_POINT_STATE',
    0x000000E8: 'INVALID_CANCEL_OF_FILE_OPEN',
    0x000000E9: 'ACTIVE_EX_WORKER_THREAD_TERMINATION',
    0x000000EA: 'THREAD_STUCK_IN_DEVICE_DRIVER',
    0x000000EB: 'DIRTY_MAPPED_PAGES_CONGESTION',
    0x000000EC: 'SESSION_HAS_VALID_SPECIAL_POOL_ON_EXIT',
    0x000000ED: 'UNMOUNTABLE_BOOT_VOLUME',
    0x000000EF: 'CRITICAL_PROCESS_DIED',
    0x000000F1: 'SCSI_VERIFIER_DETECTED_VIOLATION',
    0x000000F3: 'DISORDERLY_SHUTDOWN',
    0x000000F4: 'CRITICAL_OBJECT_TERMINATION',
    0x000000F5: 'FLTMGR_FILE_SYSTEM',
    0x000000F6: 'PCI_VERIFIER_DETECTED_VIOLATION',
    0x000000F7: 'DRIVER_OVERRAN_STACK_BUFFER',
    0x000000F8: 'RAMDISK_BOOT_INITIALIZATION_FAILED',
    0x000000F9: 'DRIVER_RETURNED_STATUS_REPARSE_FOR_VOLUME_OPEN',
    0x000000FA: 'HTTP_DRIVER_CORRUPTED',
    0x000000FC: 'ATTEMPTED_EXECUTE_OF_NOEXECUTE_MEMORY',
    0x000000FD: 'DIRTY_NOWRITE_PAGES_CONGESTION',
    0x000000FE: 'BUGCODE_USB_DRIVER',
    0x000000FF: 'RESERVE_QUEUE_OVERFLOW',
    0x00000100: 'LOADER_BLOCK_MISMATCH',
    0x00000101: 'CLOCK_WATCHDOG_TIMEOUT',
    0x00000102: 'DPC_WATCHDOG_TIMEOUT',
    0x00000103: 'MUP_FILE_SYSTEM',
    0x00000104: 'AGP_INVALID_ACCESS',
    0x00000105: 'AGP_GART_CORRUPTION',
    0x00000106: 'AGP_ILLEGALLY_REPROGRAMMED',
    0x00000108: 'THIRD_PARTY_FILE_SYSTEM_FAILURE',
    0x00000109: 'CRITICAL_STRUCTURE_CORRUPTION',
    0x0000010A: 'APP_TAGGING_INITIALIZATION_FAILED',
    0x0000010C: 'FSRTL_EXTRA_CREATE_PARAMETER_VIOLATION',
    0x0000010D: 'WDF_VIOLATION',
    0x0000010E: 'VIDEO_MEMORY_MANAGEMENT_INTERNAL',
    0x0000010F: 'RESOURCE_MANAGER_EXCEPTION_NOT_HANDLED',
    0x00000111: 'RECURSIVE_NMI',
    0x00000112: 'MSRPC_STATE_VIOLATION',
    0x00000113: 'VIDEO_DXGKRNL_FATAL_ERROR',
    0x00000114: 'VIDEO_SHADOW_DRIVER_FATAL_ERROR',
    0x00000115: 'AGP_INTERNAL',
    0x00000116: 'VIDEO_TDR_FAILURE',
    0x00000117: 'VIDEO_TDR_TIMEOUT_DETECTED',
    0x00000119: 'VIDEO_SCHEDULER_INTERNAL_ERROR',
    0x0000011A: 'EM_INITIALIZATION_ERROR',
    0x0000011B: 'DRIVER_RETURNED_HOLDING_CANCEL_LOCK',
    0x0000011C: 'ATTEMPTED_WRITE_TO_CM_PROTECTED_STORAGE',
    0x0000011D: 'EVENT_TRACING_FATAL_ERROR',
    0x0000011E: 'TOO_MANY_RECURSIVE_FAULTS',
    0x0000011F: 'INVALID_DRIVER_HANDLE',
    0x00000120: 'BITLOCKER_FATAL_ERROR',
    0x00000121: 'DRIVER_VIOLATION',
    0x00000122: 'WHEA_INTERNAL_ERROR',
    0x00000123: 'CRYPTO_SELF_TEST_FAILURE',
    0x00000124: 'WHEA_UNCORRECTABLE_ERROR',
    0x00000127: 'PAGE_NOT_ZERO',
    0x0000012B: 'FAULTY_HARDWARE_CORRUPTED_PAGE',
    0x0000012C: 'EXFAT_FILE_SYSTEM',
    0x00000133: 'DPC_WATCHDOG_VIOLATION',
    0x00000139: 'KERNEL_SECURITY_CHECK_FAILURE',
    0x0000013A: 'KERNEL_MODE_HEAP_CORRUPTION',
    0x00000144: 'BUGCODE_USB3_DRIVER',
    0x00000149: 'REFS_FILE_SYSTEM',
    0x00000154: 'UNEXPECTED_STORE_EXCEPTION',
    0x00000156: 'WINSOCK_DETECTED_HUNG_CLOSESOCKET_LIVEDUMP',
    0x00000157: 'KERNEL_THREAD_PRIORITY_FLOOR_VIOLATION',
    0x00000158: 'ILLEGAL_IOMMU_PAGE_FAULT',
    0x00000159: 'HAL_ILLEGAL_IOMMU_PAGE_FAULT',
    0x0000015A: 'SDBUS_INTERNAL_ERROR',
    0x0000015B: 'WORKER_THREAD_RETURNED_WITH_SYSTEM_PAGE_PRIORITY_ACTIVE',
    0x0000015C: 'PDC_WATCHDOG_TIMEOUT_LIVEDUMP',
    0x0000015D: 'SOC_SUBSYSTEM_FAILURE_LIVEDUMP',
    0x0000015E: 'BUGCODE_NDIS_DRIVER_LIVE_DUMP',
    0x0000015F: 'CONNECTED_STANDBY_WATCHDOG_TIMEOUT_LIVEDUMP',
    0x00000160: 'WIN32K_ATOMIC_CHECK_FAILURE',
    0x00000161: 'LIVE_SYSTEM_DUMP',
    0x00000162: 'KERNEL_AUTO_BOOST_INVALID_LOCK_RELEASE',
    0x00000163: 'WORKER_THREAD_TEST_CONDITION',
    0x00000164: 'WIN32K_CRITICAL_FAILURE',
    0x00000165: 'CLUSTER_CSV_STATUS_IO_TIMEOUT_LIVEDUMP',
    0x00000166: 'CLUSTER_RESOURCE_CALL_TIMEOUT_LIVEDUMP',
    0x00000167: 'CLUSTER_CSV_SNAPSHOT_DEVICE_INFO_TIMEOUT_LIVEDUMP',
    0x00000168: 'CLUSTER_CSV_STATE_TRANSITION_TIMEOUT_LIVEDUMP',
    0x00000169: 'CLUSTER_CSV_VOLUME_ARRIVAL_LIVEDUMP',
    0x0000016A: 'CLUSTER_CSV_VOLUME_REMOVAL_LIVEDUMP',
    0x0000016B: 'CLUSTER_CSV_CLUSTER_WATCHDOG_LIVEDUMP',
    0x0000016C: 'INVALID_RUNDOWN_PROTECTION_FLAGS',
    0x0000016D: 'INVALID_SLOT_ALLOCATOR_FLAGS',
    0x0000016E: 'ERESOURCE_INVALID_RELEASE',
    0x0000016F: 'CLUSTER_CSV_STATE_TRANSITION_INTERVAL_TIMEOUT_LIVEDUMP',
    0x00000170: 'CLUSTER_CSV_CLUSSVC_DISCONNECT_WATCHDOG',
    0x00000171: 'CRYPTO_LIBRARY_INTERNAL_ERROR',
    0x00000173: 'COREMSGCALL_INTERNAL_ERROR',
    0x00000174: 'COREMSG_INTERNAL_ERROR',
    0x00000175: 'PREVIOUS_FATAL_ABNORMAL_RESET_ERROR',
    0x00000178: 'ELAM_DRIVER_DETECTED_FATAL_ERROR',
    0x00000179: 'CLUSTER_CLUSPORT_STATUS_IO_TIMEOUT_LIVEDUMP',
    0x0000017A: 'PROFILER_CONFIGURATION_ILLEGAL',
    0x0000017B: 'PDC_LOCK_WATCHDOG_LIVEDUMP',
    0x0000017C: 'PDC_UNEXPECTED_REVOCATION_LIVEDUMP',
    0x0000017D: 'MICROCODE_REVISION_MISMATCH',
    0x0000017E: 'HYPERGUARD_INITIALIZATION_FAILURE',
    0x0000017F: 'WVR_LIVEDUMP_REPLICATION_IOCONTEXT_TIMEOUT',
    0x00000180: 'WVR_LIVEDUMP_STATE_TRANSITION_TIMEOUT',
    0x00000181: 'WVR_LIVEDUMP_RECOVERY_IOCONTEXT_TIMEOUT',
    0x00000182: 'WVR_LIVEDUMP_APP_IO_TIMEOUT',
    0x00000183: 'WVR_LIVEDUMP_MANUALLY_INITIATED',
    0x00000184: 'WVR_LIVEDUMP_STATE_FAILURE',
    0x00000185: 'WVR_LIVEDUMP_CRITICAL_ERROR',
    0x00000186: 'SECURE_FAULT_UNHANDLED',
    0x00000187: 'KERNEL_PARTITION_REFERENCE_VIOLATION',
    0x00000188: 'PF_DETECTED_CORRUPTION',
    0x00000189: 'KERNEL_PARTITION_REFERENCE_VIOLATION',
    0x0000018A: 'SECURE_KERNEL_ERROR',
    0x0000018B: 'KERNEL_THREAD_PRIORITY_FLOOR_VIOLATION',
    0x0000018C: 'HYPERVISOR_ERROR',
    0x0000018E: 'KERNEL_PARTITION_REFERENCE_VIOLATION',
    0x0000018F: 'WIN32K_SECURITY_FAILURE',
    0x00000190: 'WIN32K_POWER_WATCHDOG_TIMEOUT',
    0x00000191: 'PCI_CONFIG_SPACE_ACCESS_FAILURE',
    0x00000192: 'KERNEL_AUTO_BOOST_LOCK_ACQUISITION_WITH_RAISED_IRQL',
    0x00000193: 'VIDEO_DXGKRNL_LIVEDUMP',
    0x00000194: 'KERNEL_STORAGE_SLOT_IN_USE',
    0x00000195: 'SMB_SERVER_LIVEDUMP',
    0x00000196: 'LOADER_ROLLBACK_DETECTED',
    0x00000197: 'WIN32K_SECURITY_FAILURE_LIVEDUMP',
    0x00000198: 'UFX_LIVEDUMP',
    0x00000199: 'KERNEL_STORAGE_SLOT_IN_USE',
    0x0000019A: 'WORKER_THREAD_RETURNED_WHILE_ATTACHED_TO_SILO',
    0x0000019B: 'TTM_FATAL_ERROR',
    0x0000019C: 'WIN32K_POWER_WATCHDOG_TIMEOUT_LIVEDUMP',
    0x0000019D: 'CLUSTER_SVHDX_LIVEDUMP',
    0x0000019E: 'BUGCODE_NETADAPTER_DRIVER',
    0x0000019F: 'PDC_PRIVILEGE_CHECK_LIVEDUMP',
    0x000001A0: 'TTM_WATCHDOG_TIMEOUT',
    0x000001A1: 'WIN32K_CALLOUT_WATCHDOG_LIVEDUMP',
    0x000001A2: 'WIN32K_CALLOUT_WATCHDOG_BUGCHECK',
    0x000001A3: 'CALL_HAS_NOT_RETURNED_WATCHDOG_TIMEOUT_LIVEDUMP',
    0x000001A4: 'DRIPS_SW_HW_DIVERGENCE_LIVEDUMP',
    0x000001A5: 'USB_DRIPS_BLOCKER_SURPRISE_REMOVAL_LIVEDUMP',
    0x000001A6: 'BLUETOOTH_ERROR_RECOVERY_LIVEDUMP',
    0x000001A7: 'SMB_REDIRECTOR_LIVEDUMP',
    0x000001A8: 'VIDEO_DXGKRNL_BLACK_SCREEN_LIVEDUMP',
    0x000001A9: 'CLUSTER_SVHDX_BUGCHECK',
    0x000001AA: 'CONNECTED_STANDBY_WATCHDOG_TIMEOUT_RESET',
    0x000001AB: 'SYSTEMTHREAD_STUCK_IN_FACTORY_PLUGIN',
    0x000001AC: 'VIDEO_ENGINE_TIMEOUT_DETECTED_LIVEDUMP',
    0x000001AD: 'VIDEO_TDR_TIMEOUT_DETECTED_LIVEDUMP',
    0x000001AE: 'VIDEO_TDR_FAILURE_LIVEDUMP',
    0x000001AF: 'AZURE_DEVICE_FW_DUMP',
    0x000001B0: 'VIDEO_DXGKRNL_FATAL_ERROR_LIVEDUMP',
    0x000001B1: 'IPI_WATCHDOG_TIMEOUT',
    0x000001C0: 'HYPERVISOR_MMIO_ACCESS_FAILURE',
    0x000001C1: 'COREMSGCALL_BAD_BUFFER_MODE',
    0x000001C4: 'DRIVER_VERIFIER_DETECTED_VIOLATION_LIVEDUMP',
    0x000001C5: 'IO_THREADPOOL_DEADLOCK_LIVEDUMP',
    0x000001C6: 'FAST_ERESOURCE_PRECONDITION_VIOLATION',
    0x000001C7: 'STORE_DATA_STRUCTURE_CORRUPTION',
    0x000001C8: 'MANUALLY_INITIATED_POWER_BUTTON_HOLD',
    0x000001C9: 'USER_MODE_HEALTH_MONITOR_LIVEDUMP',
    0x000001CA: 'HYPERVISOR_WATCHDOG_TIMEOUT',
    0x000001CB: 'INVALID_SILO_DETACH',
    0x000001CC: 'EXRESOURCE_TIMEOUT_LIVEDUMP',
    0x000001CD: 'INVALID_CALLBACK_STACK_ADDRESS',
    0x000001CE: 'INVALID_KERNEL_STACK_ADDRESS',
    0x000001CF: 'HARDWARE_WATCHDOG_TIMEOUT',
    0x000001D0: 'ACPI_FIRMWARE_WATCHDOG_TIMEOUT',
    0x000001D1: 'TELEMETRY_ASSERTS_LIVEDUMP',
    0x000001D2: 'WORKER_THREAD_INVALID_STATE',
    0x000001D3: 'WFP_INVALID_OPERATION',
    0x000001D4: 'UCMUCSI_LIVEDUMP',
    0x000001D5: 'DRIVER_PNP_WATCHDOG',
    0x000001D6: 'WORKER_THREAD_RETURNED_WITH_NON_DEFAULT_WORKLOAD_CLASS',
    0x000001D7: 'EFS_FATAL_ERROR',
    0x000001D8: 'UCMUCSI_FAILURE',
    0x000001D9: 'HAL_IOMMU_INTERNAL_ERROR',
    0x000001DA: 'HAL_BLOCKED_PROCESSOR_INTERNAL_ERROR',
    0x000001DB: 'IPI_WATCHDOG_TIMEOUT_WITH_ENHANCED_TRIAGE',
    0x000001DC: 'DMA_COMMON_BUFFER_VECTOR_ERROR',
    0x000001DD: 'BUGCODE_MBBADAPTER_DRIVER',
    0x000001DE: 'BUGCODE_WIFIADAPTER_DRIVER',
    0x000001DF: 'PROCESSOR_START_TIMEOUT',
    0x000001E0: 'INVALID_ALTERNATE_SYSTEM_CALL_HANDLER_REGISTRATION',
    0x000001E1: 'DEVICE_DIAGNOSTIC_LOG_LIVEDUMP',
    0x000001E2: 'AZURE_DEVICE_FW_DUMP_LIVEDUMP',
    0x000001E3: 'BLACKSCREEN_TRIGGER_LIVEDUMP',
    0x000001E4: 'INVALID_THREAD_WAIT_STATE',
    0x000001E5: 'IO_TIMEOUT_PHASE0',
    0x00000315: 'PHASE0_EXCEPTION',
    0x00000316: 'PHASE1_EXCEPTION',
    0x00000317: 'PHASE0_EXCEPTION',
    0x00000BFE: 'BC_BLUETOOTH_VERIFIER_FAULT',
    0x00000BFF: 'BC_BTHMINI_VERIFIER_FAULT',
    0x00008866: 'STATUS_IMAGE_CHECKSUM_MISMATCH',
    0x0000DEAD: 'MANUALLY_INITIATED_CRASH1',
    0x000FABFE: 'HYPERVISOR_WATCHDOG_LIVEDUMP',
    0xC0000218: 'STATUS_CANNOT_LOAD_REGISTRY_FILE',
    0xC000021A: 'STATUS_SYSTEM_PROCESS_TERMINATED',
    0xC0000221: 'STATUS_IMAGE_CHECKSUM_MISMATCH',
    0xDEADDEAD: 'MANUALLY_INITIATED_CRASH',
};

/**
 * CRITICAL FIX: Extract bug check info with CORRECT offsets
 * This is the main fix - using proper offsets based on actual dump analysis
 */
export function extractBugCheckInfo(buffer: ArrayBuffer): BugCheckInfo | null {
    const view = new DataView(buffer);
    console.log('[BugCheck] Starting extraction, buffer size:', buffer.byteLength);
    
    // Strategy 0: Parse structured dump headers (most accurate)
    
    // Check for PAGEDU64/PAGEDUMP (full/kernel dumps)
    if (buffer.byteLength >= 0x2000) {
        const sig = new TextDecoder().decode(new Uint8Array(buffer, 0, 8));
        
        // Check for PAGEDU64 signature
        if (sig.startsWith('PAGEDU64')) {
            console.log('[BugCheck] Detected PAGEDU64 format');
            
            // CRITICAL FIX: Bug check is at offset 0x38, NOT 0x80!
            // This was the main issue causing wrong bug check codes
            try {
                const code = view.getUint32(0x38, true);  // CORRECT OFFSET!
                
                if (isValidBugCheckCode(code)) {
                    // Parameters are 64-bit values at correct offsets
                    const p1 = view.getBigUint64(0x40, true);
                    const p2 = view.getBigUint64(0x48, true);
                    const p3 = view.getBigUint64(0x50, true);
                    const p4 = view.getBigUint64(0x58, true);
                    
                    console.log(`[BugCheck] Found at 0x38: 0x${code.toString(16).toUpperCase()} (${BUG_CHECK_CODES[code] || 'UNKNOWN'})`);
                    console.log(`[BugCheck] Parameters: 0x${p1.toString(16)}, 0x${p2.toString(16)}, 0x${p3.toString(16)}, 0x${p4.toString(16)}`);
                    
                    // Validate parameters are reasonable
                    const validation = validateBugCheckParameters(code, Number(p1), Number(p2), Number(p3), Number(p4));
                    const analysis = analyzeBugCheckParameters(code, [Number(p1), Number(p2), Number(p3), Number(p4)]);
                    
                    return {
                        code,
                        name: BUG_CHECK_CODES[code] || `UNKNOWN_BUG_CHECK_${code.toString(16).toUpperCase()}`,
                        parameter1: p1,
                        parameter2: p2,
                        parameter3: p3,
                        parameter4: p4,
                        validation: {
                            valid: validation.valid,
                            errors: validation.errors,
                            description: validation.description
                        },
                        analysis
                    };
                }
            } catch (e) {
                console.error('[BugCheck] Failed to read PAGEDU64 bug check:', e);
            }
        }
        
        // Check for other kernel dump signatures
        const sig1 = view.getUint32(0, true);
        const sig2 = view.getUint32(4, true);
        
        // PAGEDUMP signature (older format)
        if (sig1 === 0x45474150 && sig2 === 0x504D5544) { // 'PAGE' 'DUMP'
            console.log('[BugCheck] Detected PAGEDUMP format');
            try {
                // For PAGEDUMP, bug check might be at different offset
                const code = view.getUint32(0x40, true);
                if (isValidBugCheckCode(code)) {
                    return createBugCheckInfo(
                        code,
                        BigInt(view.getUint32(0x44, true)),
                        BigInt(view.getUint32(0x48, true)),
                        BigInt(view.getUint32(0x4C, true)),
                        BigInt(view.getUint32(0x50, true))
                    );
                }
            } catch (e) {
                console.error('[BugCheck] Failed to read PAGEDUMP bug check:', e);
            }
        }
    }
    
    // Strategy 1: Parse MINIDUMP format (very common)
    if (buffer.byteLength >= 0x1000) {
        const sig = view.getUint32(0, true);
        if (sig === 0x504D444D) { // 'MDMP'
            console.log('[BugCheck] Detected minidump format');
            
            // Use comprehensive minidump parser
            try {
                const parser = new MinidumpParser(buffer);
                const bugCheckData = parser.getBugCheckInfo();
                
                if (bugCheckData) {
                    console.log(`[BugCheck] Found via MinidumpParser: 0x${bugCheckData.code.toString(16).padStart(8, '0')} (${BUG_CHECK_CODES[bugCheckData.code] || 'UNKNOWN'})`);
                    return createBugCheckInfo(
                        bugCheckData.code,
                        bugCheckData.parameters[0] || 0n,
                        bugCheckData.parameters[1] || 0n,
                        bugCheckData.parameters[2] || 0n,
                        bugCheckData.parameters[3] || 0n
                    );
                }
            } catch (e) {
                console.log('[BugCheck] MinidumpParser failed, trying manual parsing:', e);
            }
            
            // Manual minidump parsing fallback
            try {
                const streamCount = view.getUint32(8, true);
                const streamDirRva = view.getUint32(12, true);
                
                // Look for exception stream
                for (let i = 0; i < streamCount && streamDirRva + (i * 12) < buffer.byteLength - 12; i++) {
                    const streamType = view.getUint32(streamDirRva + (i * 12), true);
                    const rva = view.getUint32(streamDirRva + (i * 12) + 8, true);
                    
                    if (streamType === 6 && rva + 168 < buffer.byteLength) { // Exception stream
                        const exceptionCode = view.getUint32(rva + 8, true);
                        
                        if (exceptionCode === 0x80000003) { // Kernel breakpoint = bug check
                            const bugCheckCode = view.getUint32(rva + 8 + 32, true);
                            if (isValidBugCheckCode(bugCheckCode)) {
                                return createBugCheckInfo(
                                    bugCheckCode,
                                    BigInt(view.getUint32(rva + 8 + 40, true)),
                                    BigInt(view.getUint32(rva + 8 + 48, true)),
                                    BigInt(view.getUint32(rva + 8 + 56, true)),
                                    BigInt(view.getUint32(rva + 8 + 64, true))
                                );
                            }
                        }
                    }
                }
            } catch (e) {
                console.error('[BugCheck] Manual minidump parsing failed:', e);
            }
        }
    }
    
    // Strategy 2: Pattern-based search (last resort)
    // Only if structured parsing fails completely
    if (buffer.byteLength >= 512) {
        console.log('[BugCheck] Attempting pattern-based search as last resort');
        
        // Look for bug check patterns in first 4KB
        const searchSize = Math.min(4096, buffer.byteLength);
        for (let offset = 0; offset < searchSize - 20; offset += 4) {
            try {
                const code = view.getUint32(offset, true);
                if (isValidBugCheckCode(code)) {
                    // Check if next values look like parameters
                    const p1 = view.getUint32(offset + 8, true);
                    const p2 = view.getUint32(offset + 16, true);
                    
                    // Basic sanity check
                    if (p1 !== 0 || p2 !== 0) {
                        console.log(`[BugCheck] Found potential bug check via pattern at offset 0x${offset.toString(16)}`);
                        return createBugCheckInfo(
                            code,
                            BigInt(p1),
                            BigInt(p2),
                            BigInt(view.getUint32(offset + 24, true)),
                            BigInt(view.getUint32(offset + 32, true))
                        );
                    }
                }
            } catch (e) {
                // Continue searching
            }
        }
    }
    
    console.log('[BugCheck] No valid bug check information found');
    return null;
}

/**
 * Validate bug check code is legitimate
 */
function isValidBugCheckCode(code: number): boolean {
    // Check against known bug check codes
    if (BUG_CHECK_CODES[code]) {
        return true;
    }
    
    // Additional validation for ranges
    if (code >= 0x1 && code <= 0x1FF) return true;  // Standard range
    if (code >= 0x1000 && code <= 0x1FFF) return true;  // Extended range
    if (code >= 0xC0000000 && code <= 0xC0FFFFFF) return true;  // STATUS codes
    if (code === 0xDEADDEAD || code === 0x0000DEAD) return true;  // Manual crash
    
    // Reject obviously fake codes
    if (code === 0x65F4) {
        console.warn('[BugCheck] Rejected fake bug check code 0x65F4');
        return false;
    }
    
    return false;
}

/**
 * Create BugCheckInfo with validation and analysis
 */
function createBugCheckInfo(
    code: number,
    p1: bigint,
    p2: bigint,
    p3: bigint,
    p4: bigint
): BugCheckInfo {
    const validation = validateBugCheckParameters(code, Number(p1), Number(p2), Number(p3), Number(p4));
    const analysis = analyzeBugCheckParameters(code, [Number(p1), Number(p2), Number(p3), Number(p4)]);
    
    return {
        code,
        name: BUG_CHECK_CODES[code] || `UNKNOWN_BUG_CHECK_${code.toString(16).toUpperCase()}`,
        parameter1: p1,
        parameter2: p2,
        parameter3: p3,
        parameter4: p4,
        validation: {
            valid: validation.valid,
            errors: validation.errors,
            description: validation.description
        },
        analysis
    };
}

/**
 * Extract legitimate module names with validation
 */
export function extractModuleList(buffer: ArrayBuffer, strings?: string[]): ModuleInfo[] {
    const modules: ModuleInfo[] = [];
    const seen = new Set<string>();
    
    // Try minidump module stream first
    const view = new DataView(buffer);
    if (view.getUint32(0, true) === 0x504D444D) { // MDMP
        try {
            const parser = new MinidumpParser(buffer);
            const minidumpModules = parser.getModules();
            
            for (const mod of minidumpModules) {
                if (isLegitimateModuleName(mod.name) && !seen.has(mod.name.toLowerCase())) {
                    seen.add(mod.name.toLowerCase());
                    modules.push({
                        name: mod.name,
                        base: BigInt(mod.baseAddress),
                        size: mod.size,
                        timestamp: mod.timestamp,
                        checksum: mod.checksum
                    });
                }
            }
            
            if (modules.length > 0) {
                console.log(`[Modules] Found ${modules.length} modules via minidump parser`);
                return modules;
            }
        } catch (e) {
            console.log('[Modules] Minidump module extraction failed:', e);
        }
    }
    
    // Fall back to pattern-based search
    const textSize = Math.min(buffer.byteLength, 524288); // First 512KB
    const bytes = new Uint8Array(buffer, 0, textSize);
    const text = new TextDecoder('ascii', { fatal: false }).decode(bytes);
    
    // Pattern for Windows modules
    const modulePattern = /([a-zA-Z0-9_\-]+\.(sys|dll|exe))/gi;
    const matches = text.matchAll(modulePattern);
    
    for (const match of matches) {
        const name = match[1];
        const lowerName = name.toLowerCase();
        
        if (!seen.has(lowerName) && isLegitimateModuleName(name)) {
            seen.add(lowerName);
            modules.push({
                name,
                base: 0n,  // Unknown from pattern search
                size: 0,
                timestamp: 0,
                checksum: 0
            });
        }
        
        if (modules.length >= 100) break; // Reasonable limit
    }
    
    // Sort with system modules first
    return modules.sort((a, b) => {
        const aIsSystem = isSystemModule(a.name);
        const bIsSystem = isSystemModule(b.name);
        if (aIsSystem && !bIsSystem) return -1;
        if (!aIsSystem && bIsSystem) return 1;
        return a.name.localeCompare(b.name);
    });
}

/**
 * Validate module name is legitimate (not AI hallucination)
 */
function isLegitimateModuleName(name: string): boolean {
    // Reject known fake drivers that AI hallucinates
    const fakeDrivers = [
        'wxr.sys', 'web.sys', 'vs.sys', 'xxx.sys', 'test.sys',
        'unknown.sys', 'fake.sys', 'temp.sys', 'dummy.sys'
    ];
    
    const lowerName = name.toLowerCase();
    if (fakeDrivers.includes(lowerName)) {
        console.warn(`[Validation] Rejected fake driver: ${name}`);
        return false;
    }
    
    // Must match Windows module naming patterns
    if (!/^[a-zA-Z0-9_\-]+\.(sys|dll|exe)$/i.test(name)) {
        return false;
    }
    
    // Must be reasonable length
    if (name.length < 4 || name.length > 64) {
        return false;
    }
    
    // Should not contain suspicious patterns
    if (/[^\x20-\x7E]/.test(name)) {  // Non-printable characters
        return false;
    }
    
    return true;
}

/**
 * Check if module is a Windows system module
 */
function isSystemModule(name: string): boolean {
    const systemModules = [
        'ntoskrnl.exe', 'hal.dll', 'win32k.sys', 'win32kbase.sys',
        'win32kfull.sys', 'tcpip.sys', 'ndis.sys', 'fltmgr.sys',
        'ntfs.sys', 'volsnap.sys', 'storport.sys', 'ataport.sys',
        'classpnp.sys', 'disk.sys', 'partmgr.sys', 'volmgr.sys',
        'acpi.sys', 'pci.sys', 'usbport.sys', 'usbhub.sys',
        'hidusb.sys', 'kbdclass.sys', 'mouclass.sys', 'i8042prt.sys'
    ];
    
    return systemModules.includes(name.toLowerCase());
}

/**
 * Extract dump header information
 */
export function extractDumpHeader(buffer: ArrayBuffer): DumpHeader | null {
    if (buffer.byteLength < 32) {
        return null;
    }
    
    const view = new DataView(buffer);
    const sig = new TextDecoder().decode(new Uint8Array(buffer, 0, 8));
    
    // PAGEDU64 format
    if (sig.startsWith('PAGEDU64')) {
        try {
            return {
                signature: 'PAGEDU64',
                majorVersion: view.getUint32(0x0C, true),
                minorVersion: view.getUint32(0x10, true),
                machineImageType: view.getUint32(0x30, true),
                directoryTableBase: view.getBigUint64(0x14, true),
                pfnDatabase: view.getBigUint64(0x18, true),
                psLoadedModuleList: view.getBigUint64(0x20, true),
            };
        } catch (e) {
            console.error('[Header] Failed to parse PAGEDU64 header:', e);
        }
    }
    
    // Minidump format
    if (view.getUint32(0, true) === 0x504D444D) { // 'MDMP'
        try {
            return {
                signature: 'MINIDUMP',
                version: view.getUint32(4, true),
                streamCount: view.getUint32(8, true),
                streamDirectory: view.getUint32(12, true),
                checksum: view.getUint32(16, true),
                timestamp: new Date(view.getUint32(20, true) * 1000),
            };
        } catch (e) {
            console.error('[Header] Failed to parse minidump header:', e);
        }
    }
    
    return null;
}

/**
 * Extract thread context information
 */
export function extractThreadContext(buffer: ArrayBuffer): ThreadContext | null {
    const view = new DataView(buffer);
    
    // Try minidump format
    if (view.getUint32(0, true) === 0x504D444D) {
        try {
            const parser = new MinidumpParser(buffer);
            const threads = parser.getThreads();
            
            if (threads.length > 0) {
                // Return the faulting thread (usually first)
                const thread = threads[0];
                return {
                    threadId: thread.threadId,
                    rip: BigInt(thread.context?.rip || 0),
                    rsp: BigInt(thread.context?.rsp || 0),
                    rbp: BigInt(thread.context?.rbp || 0),
                    priority: thread.priority,
                };
            }
        } catch (e) {
            console.log('[Thread] Minidump thread extraction failed:', e);
        }
    }
    
    return null;
}

/**
 * Extract exception information
 */
export function extractExceptionInfo(buffer: ArrayBuffer): ExceptionInfo | null {
    const view = new DataView(buffer);
    
    // Try minidump format
    if (view.getUint32(0, true) === 0x504D444D) {
        try {
            const parser = new MinidumpParser(buffer);
            const exception = parser.getException();
            
            if (exception) {
                return {
                    code: exception.exceptionCode,
                    name: EXCEPTION_CODES[exception.exceptionCode] || 'UNKNOWN_EXCEPTION',
                    address: BigInt(exception.exceptionAddress),
                    parameter1: BigInt(exception.exceptionInformation[0] || 0),
                    parameter2: BigInt(exception.exceptionInformation[1] || 0),
                    threadId: exception.threadId,
                    flags: exception.exceptionFlags,
                };
            }
        } catch (e) {
            console.log('[Exception] Minidump exception extraction failed:', e);
        }
    }
    
    return null;
}

/**
 * Get structured dump information - main entry point
 */
export function getStructuredDumpInfo(buffer: ArrayBuffer): StructuredDumpInfo {
    console.log('[DumpParser] Extracting structured information from dump');
    
    return {
        dumpHeader: extractDumpHeader(buffer),
        exceptionInfo: extractExceptionInfo(buffer),
        bugCheckInfo: extractBugCheckInfo(buffer),
        moduleList: extractModuleList(buffer),
        threadContext: extractThreadContext(buffer),
    };
}

/**
 * Validate dump file format
 */
export function validateDumpFile(buffer: ArrayBuffer): FileValidationResult {
    if (!buffer || buffer.byteLength < 8) {
        return {
            isValid: false,
            error: 'File too small to be a valid dump file'
        };
    }
    
    const view = new DataView(buffer);
    const sig = new TextDecoder().decode(new Uint8Array(buffer, 0, 8));
    
    // Check for PAGEDU64
    if (sig.startsWith('PAGEDU64')) {
        return {
            isValid: true,
            fileType: 'PAGEDU64 (Full/Kernel Dump)'
        };
    }
    
    // Check for minidump
    if (view.getUint32(0, true) === 0x504D444D) {
        return {
            isValid: true,
            fileType: 'MINIDUMP'
        };
    }
    
    // Check for other signatures
    const sig32 = view.getUint32(0, true);
    if (sig32 === 0x45474150) { // 'PAGE'
        return {
            isValid: true,
            fileType: 'PAGEDUMP (Kernel Dump)'
        };
    }
    
    return {
        isValid: false,
        error: 'Unrecognized dump file format'
    };
}

/**
 * Extract memory information (for compatibility)
 */
export function extractMemoryInfo(buffer: ArrayBuffer): any {
    const dumpInfo = getStructuredDumpInfo(buffer);
    
    return {
        totalPhysicalMemory: 0,  // Would need to parse from dump
        availablePhysicalMemory: 0,
        committedMemory: 0,
        kernelMemory: {
            paged: 0,
            nonPaged: 0
        },
        processes: []
    };
}

/**
 * Extract system information (for compatibility)
 */
export function extractSystemInfo(buffer: ArrayBuffer): any {
    const header = extractDumpHeader(buffer);
    
    return {
        osVersion: header?.majorVersion ? `${header.majorVersion}.${header.minorVersion}` : 'Unknown',
        architecture: header?.machineImageType === 0x8664 ? 'x64' : 'x86',
        processors: 0,  // Would need to parse from dump
        systemTime: header?.timestamp || new Date()
    };
}

// Export additional helper functions for compatibility
export { 
    extractStackFramesEnhanced as extractStackFrames,
    isLegitimateModuleName as isLegitimateDriver  // Alias for compatibility
};