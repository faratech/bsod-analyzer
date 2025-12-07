// Enhanced dump file parser for BSOD analysis
// Supports both minidump and full kernel dumps

import { extractStackFrames as extractStackFramesEnhanced } from './stackExtractor.js';
import { MinidumpParser } from './minidumpStreams.js';
import { validateBugCheckParameters, analyzeBugCheckParameters, DumpValidator } from './dumpValidator.js';
import { parseContext, ParsedContext } from './contextParser.js';
import { parseKernelDumpHeader } from './kernelDumpModuleParser.js';

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
    directoryTableBase?: bigint;  // CR3 for virtual to physical translation
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
    rip?: bigint;  // Instruction pointer
    rsp?: bigint;  // Stack pointer
    rbp?: bigint;  // Base pointer
    cr3?: bigint;  // Page table base (from dump header)
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

// Common bug check codes with descriptions
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
    0x00000043: 'NO_SUCH_PARTITION',
    0x00000044: 'MULTIPLE_IRP_COMPLETE_REQUESTS',
    0x00000045: 'INSUFFICIENT_SYSTEM_MAP_REGS',
    0x00000046: 'DEREF_UNKNOWN_LOGON_SESSION',
    0x00000047: 'REF_UNKNOWN_LOGON_SESSION',
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
    0x00000125: 'NMR_INVALID_STATE',
    0x00000126: 'NETIO_INVALID_POOL_CALLER',
    0x00000127: 'PAGE_NOT_ZERO',
    0x00000128: 'WORKER_THREAD_RETURNED_WITH_BAD_IO_PRIORITY',
    0x00000129: 'WORKER_THREAD_RETURNED_WITH_BAD_PAGING_IO_PRIORITY',
    0x0000012A: 'MUI_NO_VALID_SYSTEM_LANGUAGE',
    0x0000012B: 'FAULTY_HARDWARE_CORRUPTED_PAGE',
    0x0000012C: 'EXFAT_FILE_SYSTEM',
    0x0000012D: 'VOLSNAP_OVERLAPPED_TABLE_ACCESS',
    0x0000012E: 'INVALID_MDL_RANGE',
    0x0000012F: 'VHD_BOOT_INITIALIZATION_FAILED',
    0x00000130: 'DYNAMIC_ADD_PROCESSOR_MISMATCH',
    0x00000131: 'INVALID_EXTENDED_PROCESSOR_STATE',
    0x00000132: 'RESOURCE_OWNER_POINTER_INVALID',
    0x00000133: 'DPC_WATCHDOG_VIOLATION',
    0x00000134: 'DRIVE_EXTENDER',
    0x00000135: 'REGISTRY_FILTER_DRIVER_EXCEPTION',
    0x00000136: 'VHD_BOOT_HOST_VOLUME_NOT_ENOUGH_SPACE',
    0x00000137: 'WIN32K_HANDLE_MANAGER',
    0x00000138: 'GPIO_CONTROLLER_DRIVER_ERROR',
    0x00000139: 'KERNEL_SECURITY_CHECK_FAILURE',
    0x0000013A: 'KERNEL_MODE_HEAP_CORRUPTION',
    0x0000013B: 'PASSIVE_INTERRUPT_ERROR',
    0x0000013C: 'INVALID_IO_BOOST_STATE',
    0x0000013D: 'CRITICAL_INITIALIZATION_FAILURE',
    0x00000140: 'STORAGE_DEVICE_ABNORMALITY_DETECTED',
    0x00000141: 'VIDEO_ENGINE_TIMEOUT_DETECTED',
    0x00000142: 'VIDEO_TDR_APPLICATION_BLOCKED',
    0x00000143: 'PROCESSOR_DRIVER_INTERNAL',
    0x00000144: 'BUGCODE_USB3_DRIVER',
    0x00000145: 'SECURE_BOOT_VIOLATION',
    0x00000146: 'NDIS_NET_BUFFER_LIST_INFO_ILLEGALLY_TRANSFERRED',
    0x00000147: 'ABNORMAL_RESET_DETECTED',
    0x00000148: 'IO_OBJECT_INVALID',
    0x00000149: 'REFS_FILE_SYSTEM',
    0x0000014A: 'KERNEL_WMI_INTERNAL',
    0x0000014B: 'SOC_SUBSYSTEM_FAILURE',
    0x0000014C: 'FATAL_ABNORMAL_RESET_ERROR',
    0x0000014D: 'EXCEPTION_SCOPE_INVALID',
    0x0000014E: 'SOC_CRITICAL_DEVICE_REMOVED',
    0x0000014F: 'PDC_WATCHDOG_TIMEOUT',
    0x00000150: 'TCPIP_AOAC_NIC_ACTIVE_REFERENCE_LEAK',
    0x00000151: 'UNSUPPORTED_INSTRUCTION_MODE',
    0x00000152: 'INVALID_PUSH_LOCK_FLAGS',
    0x00000153: 'KERNEL_LOCK_ENTRY_LEAKED_ON_THREAD_TERMINATION',
    0x00000154: 'UNEXPECTED_STORE_EXCEPTION',
    0x00000155: 'OS_DATA_TAMPERING',
    0x00000156: 'WINSOCK_DETECTED_HUNG_CLOSESOCKET_LIVEDUMP',
    0x00000157: 'KERNEL_THREAD_PRIORITY_FLOOR_VIOLATION',
    0x00000158: 'ILLEGAL_IOMMU_PAGE_FAULT',
    0x00000159: 'HAL_ILLEGAL_IOMMU_PAGE_FAULT',
    0x0000015A: 'SDBUS_INTERNAL_ERROR',
    0x0000015B: 'WORKER_THREAD_RETURNED_WITH_SYSTEM_PAGE_PRIORITY_ACTIVE',
    0x0000015C: 'PDC_WATCHDOG_TIMEOUT_LIVEDUMP',
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
    0x0000017B: 'PROFILER_CONFIGURATION_ILLEGAL',
    0x0000017C: 'PDC_LOCK_WATCHDOG_LIVEDUMP',
    0x0000017D: 'PDC_UNEXPECTED_REVOCATION_LIVEDUMP',
    0x00000187: 'VIDEO_DWMINIT_TIMEOUT_FALLBACK_BDD',
    0x00000188: 'CLUSTER_CSVFS_LIVEDUMP',
    0x00000189: 'BAD_OBJECT_HEADER',
    0x0000018A: 'SILO_CORRUPT',
    0x0000018B: 'SECURE_KERNEL_ERROR',
    0x0000018C: 'HYPERGUARD_VIOLATION',
    0x0000018D: 'SECURE_FAULT_UNHANDLED',
    0x0000018E: 'KERNEL_PARTITION_REFERENCE_VIOLATION',
    0x00000190: 'WIN32K_CRITICAL_FAILURE_LIVEDUMP',
    0x00000191: 'PF_DETECTED_CORRUPTION',
    0x00000192: 'KERNEL_AUTO_BOOST_LOCK_ACQUISITION_WITH_RAISED_IRQL',
    0x00000193: 'VIDEO_DXGKRNL_LIVEDUMP',
    0x00000194: 'SAVER_NONRESPONSIVEPROCESS',
    0x00000195: 'SMB_SERVER_LIVEDUMP',
    0x00000196: 'LOADER_ROLLBACK_DETECTED',
    0x00000197: 'WIN32K_SECURITY_FAILURE',
    0x00000198: 'UFX_LIVEDUMP',
    0x00000199: 'KERNEL_STORAGE_SLOT_IN_USE',
    0x0000019A: 'WORKER_THREAD_RETURNED_WHILE_ATTACHED_TO_SILO',
    0x0000019B: 'TTM_FATAL_ERROR',
    0x0000019C: 'WIN32K_POWER_WATCHDOG_TIMEOUT',
    0x0000019D: 'CLUSTER_SVHDX_LIVEDUMP',
    0x000001A0: 'TTM_WATCHDOG_TIMEOUT',
    0x000001A1: 'WIN32K_CALLOUT_WATCHDOG_LIVEDUMP',
    0x000001A2: 'WIN32K_CALLOUT_WATCHDOG_BUGCHECK',
    0x000001A3: 'CALL_HAS_NOT_RETURNED_WATCHDOG_TIMEOUT_LIVEDUMP',
    0x000001A4: 'DRIPS_SW_HW_DIVERGENCE_LIVEDUMP',
    0x000001A5: 'USB_DRIPS_BLOCKER_SURPRISE_REMOVAL_LIVEDUMP',
    0x000001A6: 'BLUETOOTH_ERROR_RECOVERY_LIVEDUMP',
    0x000001A7: 'SMB_REDIRECTOR_LIVEDUMP',
    0x000001A8: 'VIDEO_DXGKRNL_BLACK_SCREEN_LIVEDUMP',
    0x000001A9: 'DIRECTED_FX_TRANSITION_LIVEDUMP',
    0x000001AA: 'EXCEPTION_ON_INVALID_STACK',
    0x000001AB: 'UNWIND_ON_INVALID_STACK',
    0x000001AC: 'VIDEO_MINIPORT_FAILED_LIVEDUMP',
    0x000001AD: 'VIDEO_MINIPORT_BLACK_SCREEN_LIVEDUMP',
    0x000001AE: 'BUGCHECK_DURING_BUGCHECK',
    0x000001B0: 'VIDEO_MINIPORT_FAILED_LIVEDUMP',
    0x000001B8: 'VIDEO_MINIPORT_BLACK_SCREEN_LIVEDUMP',
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
    0x000001DB: 'IPI_WATCHDOG_TIMEOUT',
    0x000001DC: 'DMA_COMMON_BUFFER_VECTOR_ERROR',
    0x000001DD: 'BUGCODE_MBBADAPTER_DRIVER',
    0x000001DE: 'BUGCODE_WIFIADAPTER_DRIVER',
    0x000001DF: 'PROCESSOR_START_TIMEOUT',
    0x000001E0: 'INVALID_ALTERNATE_SYSTEM_CALL_HANDLER_REGISTRATION',
    0x000001E1: 'DEVICE_DIAGNOSTIC_LOG_LIVEDUMP',
    0x000001E2: 'AZURE_DEVICE_FW_DUMP',
    0x000001E3: 'BLACKSCREEN_WATCHDOG_TIMEOUT',
    0x000001E4: 'XBOX_CORRUPTED_IMAGE',
    0x000001E5: 'XBOX_INVERTED_FUNCTION_TABLE_OVERFLOW',
    0x000001E6: 'XBOX_CORRUPTED_IMAGE_BASE',
    0x000001E7: 'XBOX_360_SYSTEM_CRASH_RESERVED',
    0x000001E8: 'DEVICE_RESET_WATCHDOG_TIMEOUT_LIVEDUMP',
    0x000001E9: 'SECURE_PCI_CONFIG_SPACE_ACCESS_VIOLATION',
    0x000001EA: 'ABNORMAL_RESET_DEGRADED_IMAGE',
    0x000001EB: 'ACPI_PCC_WATCHDOG_TIMEOUT',
    0x000001EC: 'ACPI_FIRMWARE_FAILURE',
    0x000001ED: 'PROCESSOR_START_TIMEOUT',
    0x000001EE: 'INVALID_LOCK_ACQUISITION_ORDER',
    0x000001EF: 'RESOURCE_NOT_OWNED_BY_THREAD',
    0x000001F0: 'ACPI_HAL_VENDOR_INCOMPATIBILITY',
    0x000001F1: 'THREAD_NOT_MUTANT_OWNER',
    0x000001F2: 'CLUSTER_SVHDX_LIVEDUMP_NEW',
    0x000001F3: 'ACPI_CPEI_PROCESSOR_CACHE_ERROR',
    0x000001F4: 'ACPI_CPEI_PROCESSOR_TLB_ERROR',
    0x000001F5: 'ACPI_CPEI_PROCESSOR_BUS_ERROR',
    0x000001F6: 'ACPI_CPEI_PROCESSOR_REGISTER_FILE_ERROR',
    0x000001F7: 'ACPI_CPEI_PROCESSOR_MS_CHECK_ERROR',
    0x000001F8: 'PCI_CONFIG_SPACE_ACCESS_FAILURE',
    0x000001F9: 'DRIVER_OBJECT_RUNDOWN_RACE_DETECTED',
    0x000001FA: 'KERNEL_MODE_HEAP_CORRUPTION_LIVEDUMP',
    0x000001FB: 'XBOX_XDS_WATCHDOG_TIMEOUT',
    0x000001FC: 'USB4_HARDWARE_VIOLATION',
    0x000001FD: 'KERNEL_LOCK_ENTRY_LEAKED_ON_THREAD_TERMINATION_LIVEDUMP',
    0x00000356: 'XBOX_ERACTRL_CS_TIMEOUT',
    0x00000357: 'XBOX_CORRUPTED_IMAGE',
    0x00000358: 'XBOX_INVERTED_FUNCTION_TABLE_OVERFLOW',
    0x00000359: 'XBOX_CORRUPTED_IMAGE_BASE',
    0x00000360: 'XBOX_360_SYSTEM_CRASH',
    0x00000361: 'XBOX_360_SYSTEM_CRASH_RESERVED',
    0x00000362: 'XBOX_SECURITY_FAILUE',
    0x00000400: 'XBOX_SHUTDOWN_WATCHDOG_TIMEOUT',
    0x00000420: 'XBOX_SHUTDOWN_WATCHDOG_TIMEOUT',
    0x00000BFE: 'BC_BLUETOOTH_VERIFIER_FAULT',
    0x00000BFF: 'BC_BTHMINI_VERIFIER_FAULT',
    0x00008866: 'KERNEL_MODE_HEAP_CORRUPTION',
    0x0000F000: 'POWER_KERNEL_WATCHDOG',
    0x00020001: 'HYPERVISOR_ERROR',
    0x00040003: 'PCI_PRE_CONFIG_INIT_FAILED',
    0x00040010: 'CNSS_FILE_SYSTEM_FILTER_STACK_OVERFLOW',
    0x00040030: 'FSREC_UNLOAD_FAILED',
    0x00040050: 'NO_USER_MODE_DEBUGGING_ALLOWED',
    0x00040052: 'CSRSS_FATAL_PROCESS_ERROR',
    0x0004008E: 'PLAINTEXT_CRASH_MARKER',
    0x1000007E: 'SYSTEM_THREAD_EXCEPTION_NOT_HANDLED_M',
    0x1000007F: 'UNEXPECTED_KERNEL_MODE_TRAP_M',
    0x1000008E: 'KERNEL_MODE_EXCEPTION_NOT_HANDLED_M',
    0x100000EA: 'THREAD_STUCK_IN_DEVICE_DRIVER_M',
    0xC0000194: 'POSSIBLE_DEADLOCK',
    0xC0000218: 'STATUS_CANNOT_LOAD_REGISTRY_FILE',
    0x00000401: 'MULTIPROCESSOR_IPI_TIMEOUT',
    0x00000402: 'XBOX_360_HYPERVISOR_FAULT',
    0x00000403: 'CRITICAL_INITIALIZATION_FAILURE',
    0x000C0050: 'DRIVER_CORRUPTED_MMPOOL',
    0x10000050: 'PAGE_FAULT_IN_NONPAGED_AREA_M',
    0x4000008A: 'THREAD_TERMINATE_HELD_MUTEX',
    0xC000021A: 'STATUS_SYSTEM_PROCESS_TERMINATED',
    0xC0000221: 'STATUS_IMAGE_CHECKSUM_MISMATCH',
    0xC000026C: 'INCONSISTENT_PROCESSOR_MTRR',
    0xDEADDEAD: 'MANUALLY_INITIATED_CRASH1',
};

// Machine types
const MACHINE_TYPES: Record<number, string> = {
    0x014C: 'x86',
    0x0200: 'IA64',
    0x8664: 'x64',
    0xAA64: 'ARM64',
};

export function validateDumpFile(buffer: ArrayBuffer, filename: string): FileValidationResult {
    if (buffer.byteLength < 32) {
        return {
            isValid: false,
            error: `File is too small to be a valid dump file (${buffer.byteLength} bytes)`
        };
    }
    
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    
    // Check for known dump file signatures
    // PAGEDUMP signature (full/kernel dumps) - can be "PAGEDUMP" or "PAGEDU64"
    if (bytes[0] === 0x50 && bytes[1] === 0x41 && bytes[2] === 0x47 && bytes[3] === 0x45 &&
        bytes[4] === 0x44 && bytes[5] === 0x55) {
        // Check for both PAGEDUMP and PAGEDU64
        if ((bytes[6] === 0x4D && bytes[7] === 0x50) || // "MP" for PAGEDUMP
            (bytes[6] === 0x36 && bytes[7] === 0x34)) { // "64" for PAGEDU64
            return { isValid: true, fileType: 'PAGEDUMP' };
        }
    }
    
    // Alternative PAGEDUMP format (4-byte chunks)
    const sig1 = view.getUint32(0, true);
    const sig2 = view.getUint32(4, true);
    if (sig1 === 0x45474150 && sig2 === 0x504D5544) { // "PAGE" "DUMP"
        return { isValid: true, fileType: 'PAGEDUMP' };
    }
    
    // MINIDUMP signature
    if (sig1 === 0x504D444D) { // "MDMP"
        return { isValid: true, fileType: 'MINIDUMP' };
    }
    
    // Legacy DUMP format
    if (sig1 === 0x44554D50) { // "DUMP"
        return { isValid: true, fileType: 'DUMP' };
    }
    
    // Check for common non-dump file signatures
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
        bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) {
        return {
            isValid: false,
            fileType: 'PNG',
            error: 'This is a PNG image file, not a Windows crash dump. Please upload actual .dmp files from C:\\Windows\\Minidump\\'
        };
    }
    
    if (bytes[0] === 0x4D && bytes[1] === 0x5A) { // "MZ"
        return {
            isValid: false,
            fileType: 'EXE',
            error: 'This is a Windows executable file, not a crash dump'
        };
    }
    
    if (bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04) {
        return {
            isValid: false,
            fileType: 'ZIP',
            error: 'This appears to be a ZIP archive. Please extract the .dmp files first'
        };
    }
    
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) { // "%PDF"
        return {
            isValid: false,
            fileType: 'PDF',
            error: 'This is a PDF document, not a crash dump file'
        };
    }
    
    if ((bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) &&
        (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) { // "GIF87a" or "GIF89a"
        return {
            isValid: false,
            fileType: 'GIF',
            error: 'This is a GIF image file, not a crash dump'
        };
    }
    
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
        return {
            isValid: false,
            fileType: 'JPEG',
            error: 'This is a JPEG image file, not a crash dump. Screenshots cannot be analyzed - please upload actual .dmp files'
        };
    }
    
    // Unknown format - show hex preview
    const hexPreview = Array.from(bytes.slice(0, 32))
        .map(b => b.toString(16).padStart(2, '0'))
        .join(' ');
    
    return {
        isValid: false,
        error: `Unknown file format. First 32 bytes: ${hexPreview}. Valid dump files have extensions like .dmp, .mdmp, .hdmp, or .kdmp`
    };
}

export function extractDumpHeader(buffer: ArrayBuffer): DumpHeader | null {
    if (buffer.byteLength < 32) return null;
    
    const view = new DataView(buffer);
    
    // Check for PAGEDUMP signature (full/kernel dumps)
    const sig1 = view.getUint32(0, true);
    if (sig1 === 0x45474150) { // "PAGE"
        const sig2 = view.getUint32(4, true);
        if (sig2 === 0x504D5544) { // "DUMP"
            return extractPageDumpHeader(view);
        }
    }
    
    // Check for minidump signature
    if (sig1 === 0x504D444D) { // "MDMP"
        return extractMinidumpHeader(view);
    }
    
    // Check for older dump formats
    if (sig1 === 0x44554D50) { // "DUMP"
        return extractLegacyDumpHeader(view);
    }
    
    return null;
}

function extractPageDumpHeader(view: DataView): DumpHeader {
    // Try to use the comprehensive kernel dump parser first
    try {
        const kernelHeader = parseKernelDumpHeader(view.buffer);
        if (kernelHeader) {
            const header: DumpHeader = {
                signature: kernelHeader.signature,
                majorVersion: kernelHeader.majorVersion,
                minorVersion: kernelHeader.minorVersion,
                machineImageType: kernelHeader.machineImageType,
                directoryTableBase: kernelHeader.directoryTableBase,
                pfnDatabase: kernelHeader.pfnDatabase,
                psLoadedModuleList: kernelHeader.psLoadedModuleList,
            };
            
            // Add physical memory runs if available
            if (kernelHeader.physicalMemoryDescriptor) {
                header.physicalMemoryRuns = kernelHeader.physicalMemoryDescriptor.runs;
            }
            
            return header;
        }
    } catch (e) {
        console.error('Kernel dump parser failed, falling back to basic parsing:', e);
    }
    
    // Fallback to basic parsing
    const header: DumpHeader = {
        signature: 'PAGEDUMP',
        majorVersion: view.getUint32(8, true),
        minorVersion: view.getUint32(12, true),
    };
    
    // Machine type at offset 32
    if (view.byteLength >= 36) {
        const machineType = view.getUint32(32, true);
        header.machineImageType = machineType;
    }
    
    // For PAGEDU64 dumps, extract DirectoryTableBase (CR3)
    if (view.byteLength >= 0x20) {
        try {
            // Check if this is a 64-bit dump
            const bytes = new Uint8Array(view.buffer, view.byteOffset, 8);
            const sig = String.fromCharCode(...bytes);
            if (sig.includes('64')) {
                // DirectoryTableBase is at offset 0x18 in PAGEDU64
                header.directoryTableBase = view.getBigUint64(0x18, true);
            }
        } catch (e) {
            // Continue without CR3
        }
    }
    
    // PFN database and module list for 64-bit dumps
    if (view.byteLength >= 0xA0) {
        try {
            header.pfnDatabase = view.getBigUint64(0x80, true);
            header.psLoadedModuleList = view.getBigUint64(0x90, true);
        } catch (e) {
            // Fallback for 32-bit
            header.pfnDatabase = BigInt(view.getUint32(0x80, true));
            header.psLoadedModuleList = BigInt(view.getUint32(0x90, true));
        }
    }
    
    // Try to extract physical memory runs
    header.physicalMemoryRuns = extractPhysicalMemoryRuns(view);
    
    return header;
}

function extractMinidumpHeader(view: DataView): DumpHeader {
    const header: DumpHeader = {
        signature: 'MINIDUMP',
        version: view.getUint32(4, true),
        streamCount: view.getUint32(8, true),
        streamDirectory: view.getUint32(12, true),
    };
    
    // Checksum and timestamp
    if (view.byteLength >= 24) {
        header.checksum = view.getUint32(16, true);
        const timestamp = view.getUint32(20, true);
        header.timestamp = new Date(timestamp * 1000);
    }
    
    return header;
}

// Extract physical memory run information from dump
function extractPhysicalMemoryRuns(view: DataView): Array<{basePage: bigint; pageCount: bigint}> | null {
    const runs: Array<{basePage: bigint; pageCount: bigint}> = [];
    
    try {
        // For PAGEDU64 dumps, physical memory descriptor is typically after the header
        // This is a simplified approach - real implementation would parse the full structure
        const physMemOffset = 0x2000; // Common offset for physical memory descriptor
        
        if (view.byteLength > physMemOffset + 16) {
            const numberOfRuns = view.getUint32(physMemOffset, true);
            
            if (numberOfRuns > 0 && numberOfRuns < 100) { // Sanity check
                const runOffset = physMemOffset + 16; // Skip header
                
                for (let i = 0; i < Math.min(numberOfRuns, 20); i++) {
                    const offset = runOffset + i * 16;
                    if (offset + 16 > view.byteLength) break;
                    
                    const basePage = view.getBigUint64(offset, true);
                    const pageCount = view.getBigUint64(offset + 8, true);
                    
                    // Validate the run looks reasonable
                    if (pageCount > 0n && pageCount < 0x100000000n) {
                        runs.push({ basePage, pageCount });
                    }
                }
            }
        }
    } catch (e) {
        // Continue without physical memory runs
    }
    
    return runs.length > 0 ? runs : null;
}

function extractLegacyDumpHeader(view: DataView): DumpHeader {
    return {
        signature: 'DUMP_LEGACY',
        majorVersion: view.getUint32(4, true),
        minorVersion: view.getUint32(8, true),
    };
}

export function extractExceptionInfo(buffer: ArrayBuffer): ExceptionInfo | null {
    const view = new DataView(buffer);
    
    // Search for exception codes in the first 64KB
    const searchLimit = Math.min(buffer.byteLength, 65536);
    
    for (let i = 0; i < searchLimit - 32; i += 4) {
        const code = view.getUint32(i, true);
        
        if (EXCEPTION_CODES[code]) {
            // Found a known exception code, extract the record
            try {
                // EXCEPTION_RECORD64 structure
                const info: ExceptionInfo = {
                    code: code,
                    name: EXCEPTION_CODES[code],
                    address: view.getBigUint64(i + 8, true),
                    parameter1: view.getBigUint64(i + 24, true),
                    parameter2: view.getBigUint64(i + 32, true),
                };
                
                // Validate the address looks reasonable (kernel space)
                if (info.address > BigInt('0xFFFF000000000000') || info.address < BigInt('0x1000')) {
                    continue; // Invalid address, keep searching
                }
                
                return info;
            } catch (e) {
                // Try 32-bit structure
                try {
                    const info: ExceptionInfo = {
                        code: code,
                        name: EXCEPTION_CODES[code],
                        address: BigInt(view.getUint32(i + 4, true)),
                        parameter1: BigInt(view.getUint32(i + 12, true)),
                        parameter2: BigInt(view.getUint32(i + 16, true)),
                    };
                    return info;
                } catch (e) {
                    continue;
                }
            }
        }
    }
    
    return null;
}

// Helper function to validate bug check parameters
function isValidBugCheckCode(code: number): boolean {
    // Check against known bug check codes first
    if (BUG_CHECK_CODES[code]) {
        return true;
    }
    
    // Reject obviously fake codes
    if (code === 0x65F4) {
        console.warn('[BugCheck] Rejected fake bug check code 0x65F4');
        return false;
    }
    
    // Valid bug check codes are typically:
    // - Between 0x01 and 0xFF for standard codes
    // - Between 0x100 and 0x1FF for extended codes
    // - Some special codes in 0x1000+ range
    // - Some codes in 0xC0000000+ range (STATUS codes used as bug checks)
    return (code > 0 && code <= 0xFF) ||
           (code >= 0x100 && code <= 0x1FF) ||
           (code >= 0x1000 && code <= 0x10000) ||
           (code >= 0xC0000000 && code <= 0xC0FFFFFF) ||
           (code >= 0x4000008A && code <= 0x40000100) ||
           code === 0xDEADDEAD || code === 0x0000DEAD;
}

// Helper to validate parameters based on bug check code
function validateBugCheckParameters(code: number, p1: number, p2: number, p3: number, p4: number): boolean {
    // Special validation for known bug check codes
    switch (code) {
        case 0x1E: // KMODE_EXCEPTION_NOT_HANDLED
            // P1 should be a valid exception code
            return (p1 >= 0xC0000000 && p1 <= 0xC0FFFFFF) || p1 === 0x80000003;
            
        case 0x50: // PAGE_FAULT_IN_NONPAGED_AREA
        case 0x7E: // SYSTEM_THREAD_EXCEPTION_NOT_HANDLED
        case 0xA: // IRQL_NOT_LESS_OR_EQUAL
        case 0xD1: // DRIVER_IRQL_NOT_LESS_OR_EQUAL
            // P2 should be a kernel address (high bits set)
            return p2 === 0 || p2 > 0x80000000;
            
        case 0x133: // DPC_WATCHDOG_VIOLATION
            // P1 is 0 or 1, P2 is timeout value
            return (p1 === 0 || p1 === 1) && p2 > 0;
            
        case 0x124: // WHEA_UNCORRECTABLE_ERROR
            // P1 is error source
            return p1 >= 0 && p1 <= 0x10;
            
        default:
            // For unknown codes, at least one parameter should be non-zero
            // and not all 0xFFFFFFFF
            return (p1 !== 0 || p2 !== 0 || p3 !== 0 || p4 !== 0) &&
                   !(p1 === 0xFFFFFFFF && p2 === 0xFFFFFFFF && p3 === 0xFFFFFFFF && p4 === 0xFFFFFFFF);
    }
}

// Helper function to create BugCheckInfo with validation
function createBugCheckInfo(code: number, p1: bigint, p2: bigint, p3: bigint, p4: bigint): BugCheckInfo {
    const params = [p1, p2, p3, p4];
    const validation = validateBugCheckParameters(code, params);
    const analysis = analyzeBugCheckParameters(code, params);
    
    return {
        code,
        name: BUG_CHECK_CODES[code] || `UNKNOWN_BUG_CHECK_0x${code.toString(16).toUpperCase()}`,
        parameter1: p1,
        parameter2: p2,
        parameter3: p3,
        parameter4: p4,
        validation,
        analysis
    };
}

export function extractBugCheckInfo(buffer: ArrayBuffer): BugCheckInfo | null {
    const view = new DataView(buffer);
    console.log('[BugCheck] Starting bug check extraction, buffer size:', buffer.byteLength);
    
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
                console.log('[BugCheck] MinidumpParser failed, falling back to legacy parsing');
            }
            
            // Fall back to legacy parsing if comprehensive parser fails
            try {
                const streamCount = view.getUint32(8, true);
                const streamDirRva = view.getUint32(12, true);
                
                // Look through streams for exception stream (type 6)
                for (let i = 0; i < streamCount && streamDirRva + (i * 12) < buffer.byteLength - 12; i++) {
                    const streamType = view.getUint32(streamDirRva + (i * 12), true);
                    const dataSize = view.getUint32(streamDirRva + (i * 12) + 4, true);
                    const rva = view.getUint32(streamDirRva + (i * 12) + 8, true);
                    
                    if (streamType === 6 && rva + 168 < buffer.byteLength) { // Exception stream
                        // MINIDUMP_EXCEPTION_STREAM structure:
                        // ThreadId (4 bytes)
                        // __Alignment (4 bytes)
                        // ExceptionRecord (MINIDUMP_EXCEPTION structure - 152 bytes)
                        // ThreadContext (MINIDUMP_LOCATION_DESCRIPTOR - 8 bytes)
                        
                        // Skip ThreadId and alignment to get to MINIDUMP_EXCEPTION
                        const exceptionOffset = rva + 8;
                        
                        // MINIDUMP_EXCEPTION structure:
                        // ExceptionCode (4 bytes) - this is NOT the bug check code
                        // ExceptionFlags (4 bytes)
                        // ExceptionRecord (8 bytes)
                        // ExceptionAddress (8 bytes)
                        // NumberParameters (4 bytes)
                        // __unusedAlignment (4 bytes)
                        // ExceptionInformation[15] (120 bytes)
                        
                        const exceptionCode = view.getUint32(exceptionOffset, true);
                        console.log(`[BugCheck] Found exception code in stream: 0x${exceptionCode.toString(16).padStart(8, '0')}`);
                        
                        // For kernel dumps, the bug check info is in ExceptionInformation
                        if (exceptionCode === 0x80000003) { // BREAKPOINT - indicates kernel crash
                            // Bug check code is in ExceptionInformation[0]
                            const bugCheckCode = view.getUint32(exceptionOffset + 32, true);
                            const p1 = view.getUint32(exceptionOffset + 40, true);
                            const p2 = view.getUint32(exceptionOffset + 48, true);
                            const p3 = view.getUint32(exceptionOffset + 56, true);
                            const p4 = view.getUint32(exceptionOffset + 64, true);
                            
                            if (isValidBugCheckCode(bugCheckCode)) {
                                console.log(`[BugCheck] Found bug check in ExceptionInformation: 0x${bugCheckCode.toString(16).padStart(8, '0')} (${BUG_CHECK_CODES[bugCheckCode] || 'UNKNOWN'})`);
                                if (validateBugCheckParameters(bugCheckCode, p1, p2, p3, p4)) {
                                    return createBugCheckInfo(bugCheckCode, BigInt(p1), BigInt(p2), BigInt(p3), BigInt(p4));
                                }
                            }
                        }
                    }
                }
                
                // If no exception stream, check common offsets in minidumps
                const commonOffsets = [0x80, 0x88, 0x90, 0xA0, 0xB0, 0xC0, 0x100, 0x104, 0x120, 0x200];
                for (const offset of commonOffsets) {
                    if (offset + 20 > buffer.byteLength) continue;
                    
                    const code = view.getUint32(offset, true);
                    if (isValidBugCheckCode(code)) {
                        try {
                            const p1 = view.getUint32(offset + 4, true);
                            const p2 = view.getUint32(offset + 8, true);
                            const p3 = view.getUint32(offset + 12, true);
                            const p4 = view.getUint32(offset + 16, true);
                            
                            if (validateBugCheckParameters(code, p1, p2, p3, p4)) {
                                return createBugCheckInfo(code, BigInt(p1), BigInt(p2), BigInt(p3), BigInt(p4));
                            }
                        } catch (e) {
                            continue;
                        }
                    }
                }
            } catch (e) {
                // Continue to next strategy
            }
        }
    }
    
    // Strategy 2: Look for KiBugCheckData pattern (kernel dumps)
    const kibugPattern = new Uint8Array([0x4B, 0x69, 0x42, 0x75, 0x67]); // "KiBug"
    for (let i = 0; i < Math.min(buffer.byteLength, 65536) - 100; i++) {
        let found = true;
        for (let j = 0; j < kibugPattern.length; j++) {
            if (view.getUint8(i + j) !== kibugPattern[j]) {
                found = false;
                break;
            }
        }
        if (found) {
            // Bug check data typically follows within 64 bytes
            for (let offset = i; offset < i + 64 && offset < buffer.byteLength - 20; offset += 4) {
                const code = view.getUint32(offset, true);
                if (isValidBugCheckCode(code)) {
                    try {
                        const p1 = view.getUint32(offset + 4, true);
                        const p2 = view.getUint32(offset + 8, true);
                        const p3 = view.getUint32(offset + 12, true);
                        const p4 = view.getUint32(offset + 16, true);
                        
                        if (validateBugCheckParameters(code, p1, p2, p3, p4)) {
                            return {
                                code: code,
                                name: BUG_CHECK_CODES[code] || `UNKNOWN_BUG_CHECK_0x${code.toString(16).toUpperCase()}`,
                                parameter1: BigInt(p1),
                                parameter2: BigInt(p2),
                                parameter3: BigInt(p3),
                                parameter4: BigInt(p4),
                            };
                        }
                    } catch (e) {
                        continue;
                    }
                }
            }
        }
    }
    
    // Strategy 3: Look for bug check codes in TEXT section patterns
    // Sometimes bug check info is embedded in exception messages
    const textPatterns = [
        /\*\*\* STOP: 0x([0-9A-F]{8})/i,
        /BugCheck ([0-9A-F]+),/i,
        /BUGCHECK_CODE:\s*([0-9A-F]+)/i,
        /Stop 0x([0-9A-F]+)/i,
    ];
    
    // Convert first 64KB to string for pattern matching
    const textBuffer = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 65536));
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const text = decoder.decode(textBuffer);
    
    for (const pattern of textPatterns) {
        const match = text.match(pattern);
        if (match) {
            const codeStr = match[1];
            const code = parseInt(codeStr, 16);
            if (isValidBugCheckCode(code)) {
                // Try to find parameters near the code
                const codeIndex = text.indexOf(match[0]);
                const nearbyText = text.substring(Math.max(0, codeIndex - 100), Math.min(text.length, codeIndex + 200));
                
                // Look for parameter patterns
                const paramPattern = /\{([0-9A-Fx]+),\s*([0-9A-Fx]+),\s*([0-9A-Fx]+),\s*([0-9A-Fx]+)\}/i;
                const paramMatch = nearbyText.match(paramPattern);
                
                if (paramMatch) {
                    const p1 = parseInt(paramMatch[1].replace('0x', ''), 16);
                    const p2 = parseInt(paramMatch[2].replace('0x', ''), 16);
                    const p3 = parseInt(paramMatch[3].replace('0x', ''), 16);
                    const p4 = parseInt(paramMatch[4].replace('0x', ''), 16);
                    
                    if (validateBugCheckParameters(code, p1, p2, p3, p4)) {
                        return createBugCheckInfo(code, BigInt(p1), BigInt(p2), BigInt(p3), BigInt(p4));
                    }
                }
                
                // Return with zero parameters if we can't find them
                return createBugCheckInfo(code, 0n, 0n, 0n, 0n);
            }
        }
    }
    
    // Strategy 4: Comprehensive heuristic search
    // Last resort - search for any valid bug check pattern
    const searchLimit = Math.min(buffer.byteLength, 131072); // Search first 128KB
    for (let i = 0; i < searchLimit - 20; i += 4) {
        const code = view.getUint32(i, true);
        
        if (isValidBugCheckCode(code)) {
            try {
                const p1 = view.getUint32(i + 4, true);
                const p2 = view.getUint32(i + 8, true);
                const p3 = view.getUint32(i + 12, true);
                const p4 = view.getUint32(i + 16, true);
                
                if (validateBugCheckParameters(code, p1, p2, p3, p4)) {
                    // Additional context validation for common bug checks
                    let isLikelyValid = false;
                    
                    // Check if this matches known patterns
                    switch (code) {
                        case 0x1E: // KMODE_EXCEPTION_NOT_HANDLED
                            // Check if p2 looks like a kernel address
                            isLikelyValid = p2 > 0x80000000 || (p2 >= 0xFFFFF800 && p2 <= 0xFFFFFFFF);
                            break;
                            
                        case 0x50: // PAGE_FAULT_IN_NONPAGED_AREA
                        case 0xA: // IRQL_NOT_LESS_OR_EQUAL
                            // Check if p1 (address) and p4 (instruction) look valid
                            isLikelyValid = (p4 > 0x80000000 || (p4 >= 0xFFFFF800 && p4 <= 0xFFFFFFFF));
                            break;
                            
                        case 0x133: // DPC_WATCHDOG_VIOLATION
                            // P1 should be 0 or 1
                            isLikelyValid = (p1 === 0 || p1 === 1) && p2 > 0 && p2 < 0x10000;
                            break;
                            
                        default:
                            // For other codes, check if we have at least one kernel address
                            isLikelyValid = (p1 > 0x80000000 || p2 > 0x80000000 || 
                                           p3 > 0x80000000 || p4 > 0x80000000) ||
                                          (code >= 0xC0000000); // STATUS codes
                            break;
                    }
                    
                    if (isLikelyValid) {
                        return createBugCheckInfo(code, BigInt(p1), BigInt(p2), BigInt(p3), BigInt(p4));
                    }
                }
            } catch (e) {
                continue;
            }
        }
    }
    
    return null;
}

// Helper function to validate module names and filter out AI hallucinations
export function isLegitimateModuleName(name: string): boolean {
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
    
    return true;
}

export function extractModuleList(buffer: ArrayBuffer, strings: string): ModuleInfo[] {
    const modules: ModuleInfo[] = [];
    const seen = new Set<string>();
    
    // First try minidump module stream for accurate data
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
    
    // Enhanced patterns for better module detection
    const modulePatterns = [
        // Standard module names
        new RegExp('([a-zA-Z0-9_\\-]+\\.(sys|dll|exe))', 'gi'),
        // Module with version info
        new RegExp('([a-zA-Z0-9_\\-]+\\.(sys|dll|exe))\\s+\\d+\\.\\d+\\.\\d+\\.\\d+', 'gi'),
        // Module with company name
        new RegExp('(\\w+\\s+\\w+)?\\s*-\\s*([a-zA-Z0-9_\\-]+\\.(sys|dll|exe))', 'gi'),
        // Full path modules
        new RegExp('[A-Z]:\\\\[^"<>|?*\\n\\r]+\\\\([a-zA-Z0-9_\\-]+\\.(sys|dll|exe))', 'gi'),
        // System32 modules
        new RegExp('system32\\\\([a-zA-Z0-9_\\-]+\\.(sys|dll|exe))', 'gi')
    ];
    
    // First pass: Extract all module names
    for (const pattern of modulePatterns) {
        const matches = strings.matchAll(pattern);
        for (const match of matches) {
            // Extract just the filename
            let name = match[match.length - 1] || match[1];
            if (name.includes('\\')) {
                name = name.substring(name.lastIndexOf('\\') + 1);
            }
            name = name.toLowerCase();
            
            // Filter out common false positives and validate
            if (!seen.has(name) && 
                !name.includes('...') &&
                isLegitimateModuleName(name)) {
                seen.add(name);
                modules.push({
                    name: name,
                    base: 0n,
                    size: 0,
                });
            }
            
            if (modules.length >= 100) break;
        }
    }
    
    // Second pass: Prioritize important modules
    const priorityModules = modules.sort((a, b) => {
        // System modules first
        const aIsSystem = a.name.startsWith('nt') || a.name.startsWith('hal') || 
                         a.name.includes('kernel') || a.name.startsWith('win32k');
        const bIsSystem = b.name.startsWith('nt') || b.name.startsWith('hal') || 
                         b.name.includes('kernel') || b.name.startsWith('win32k');
        if (aIsSystem && !bIsSystem) return -1;
        if (!aIsSystem && bIsSystem) return 1;
        
        // Then drivers (.sys)
        const aIsDriver = a.name.endsWith('.sys');
        const bIsDriver = b.name.endsWith('.sys');
        if (aIsDriver && !bIsDriver) return -1;
        if (!aIsDriver && bIsDriver) return 1;
        
        return 0;
    });
    
    // Try to extract module info from binary structures (reuse existing view)
    // const view already declared above
    
    // Look for PE headers (MZ signature)
    for (let i = 0; i < Math.min(buffer.byteLength - 64, 100000); i += 8) {
        if (view.getUint16(i, true) === 0x5A4D) { // "MZ"
            try {
                const e_lfanew = view.getUint32(i + 60, true);
                if (i + e_lfanew + 4 < buffer.byteLength) {
                    const peSignature = view.getUint32(i + e_lfanew, true);
                    if (peSignature === 0x00004550) { // "PE\0\0"
                        // Found a PE header, extract info
                        const machine = view.getUint16(i + e_lfanew + 4, true);
                        const timestamp = view.getUint32(i + e_lfanew + 8, true);
                        const sizeOfImage = view.getUint32(i + e_lfanew + 80, true);
                        
                        // Try to find module name nearby
                        const nearbyString = extractNearbyString(buffer, i, 256);
                        if (nearbyString && nearbyString.match(/\.(sys|dll|exe)/i)) {
                            modules.push({
                                name: nearbyString,
                                base: BigInt(i),
                                size: sizeOfImage,
                                timestamp: timestamp,
                            });
                        }
                    }
                }
            } catch (e) {
                continue;
            }
        }
    }
    
    return modules;
}

export function extractThreadContext(buffer: ArrayBuffer): ThreadContext | null {
    const view = new DataView(buffer);
    
    // Look for CONTEXT structure markers
    // x64 CONTEXT starts with P1Home-P6Home (6 * 8 bytes of home space)
    // followed by ContextFlags
    
    for (let i = 0; i < Math.min(buffer.byteLength - 0x500, 65536); i += 8) {
        try {
            // Check for CONTEXT_FULL flag (0x10000b)
            const contextFlags = view.getUint32(i + 48, true);
            if (contextFlags === 0x10000b || contextFlags === 0x10003b) {
                // Found potential CONTEXT structure
                const context: ThreadContext = {
                    threadId: 0, // Would need thread info to determine
                };
                
                // Extract registers (offsets for x64 CONTEXT)
                const ripOffset = i + 0xF8;
                const rspOffset = i + 0x98;
                const rbpOffset = i + 0xA0;
                
                if (ripOffset + 8 <= buffer.byteLength) {
                    context.rip = view.getBigUint64(ripOffset, true);
                    context.rsp = view.getBigUint64(rspOffset, true);
                    context.rbp = view.getBigUint64(rbpOffset, true);
                    
                    // Validate that these look like valid addresses
                    if (context.rip! > 0xFFFF000000000000n && context.rsp! > 0xFFFF000000000000n) {
                        // Try to get CR3 from dump header
                        const header = extractDumpHeader(buffer);
                        if (header && header.directoryTableBase) {
                            context.cr3 = header.directoryTableBase;
                        }
                        return context;
                    }
                }
            }
        } catch (e) {
            continue;
        }
    }
    
    return null;
}

export function extractStackFrames(buffer: ArrayBuffer, context: ThreadContext | null): string[] {
    // Get dump header for physical memory information
    const header = extractDumpHeader(buffer);
    
    // Create enhanced context with CR3 and physical memory runs
    const enhancedContext = context ? {
        rsp: context.rsp,
        rbp: context.rbp,
        cr3: context.cr3 || header?.directoryTableBase,
        physicalMemoryRuns: header?.physicalMemoryRuns
    } : null;
    
    // Use the enhanced stack extractor with virtual to physical translation
    return extractStackFramesEnhanced(buffer, enhancedContext);
}

function extractStackTracePatterns(buffer: ArrayBuffer): string[] {
    const stackPatterns: string[] = [];
    const byteView = new Uint8Array(buffer);
    const decoder = new TextDecoder('ascii', { fatal: false });
    
    // Enhanced patterns for better stack trace detection
    // Use RegExp constructor to avoid minification issues with regex flags
    const patterns = [
        // Kernel functions
        new RegExp('nt![A-Za-z][A-Za-z0-9_]+', 'g'),
        new RegExp('hal![A-Za-z][A-Za-z0-9_]+', 'g'),
        new RegExp('win32k(full|base)?![A-Za-z][A-Za-z0-9_]+', 'g'),
        
        // Driver functions with offsets
        new RegExp('[A-Za-z][A-Za-z0-9_\\-]+\\.sys(\\+0x[0-9a-fA-F]+)?', 'g'),
        new RegExp('[A-Za-z][A-Za-z0-9_\\-]+![A-Za-z][A-Za-z0-9_]+(\\+0x[0-9a-fA-F]+)?', 'g'),
        
        // Common Windows kernel functions
        new RegExp('Kf[A-Za-z]+[A-Za-z0-9_]*', 'g'),  // KfRaiseIrql, etc.
        new RegExp('Ki[A-Za-z]+[A-Za-z0-9_]*', 'g'),  // KiSystemCall64, etc.
        new RegExp('Ke[A-Za-z]+[A-Za-z0-9_]*', 'g'),  // KeWaitForSingleObject, etc.
        new RegExp('Ex[A-Za-z]+[A-Za-z0-9_]*', 'g'),  // ExAllocatePool, etc.
        new RegExp('Io[A-Za-z]+[A-Za-z0-9_]*', 'g'),  // IoCompleteRequest, etc.
        new RegExp('Mm[A-Za-z]+[A-Za-z0-9_]*', 'g'),  // MmMapLockedPages, etc.
        
        // Memory addresses that might be function pointers
        new RegExp('0x[fF]{4}[0-9a-fA-F]{12}', 'g'),  // 64-bit kernel addresses
        new RegExp('0x[8-9a-fA-F][0-9a-fA-F]{7}', 'g')  // 32-bit kernel addresses
    ];
    
    // Priority keywords that indicate stack frames
    const priorityKeywords = [
        'KeBugCheckEx',
        'KeBugCheck',
        'KiPageFault',
        'KiSystemServiceCopyEnd',
        'KiExceptionDispatch',
        'KiTrap',
        'KiFastFailDispatch'
    ];
    
    // Search in larger chunks for better context
    const chunkSize = 8192;
    const searchLimit = Math.min(buffer.byteLength, 131072); // Search first 128KB
    
    // First pass: Look for priority keywords
    for (let offset = 0; offset < searchLimit; offset += chunkSize) {
        const chunkEnd = Math.min(offset + chunkSize + 256, buffer.byteLength);
        const chunk = new Uint8Array(buffer, offset, chunkEnd - offset);
        const text = decoder.decode(chunk);
        
        for (const keyword of priorityKeywords) {
            if (text.includes(keyword)) {
                // Extract context around the keyword
                const index = text.indexOf(keyword);
                const contextStart = Math.max(0, index - 100);
                const contextEnd = Math.min(text.length, index + 200);
                const context = text.substring(contextStart, contextEnd);
                
                // Extract all patterns from this context
                for (const pattern of patterns) {
                    const matches = context.matchAll(pattern);
                    for (const match of matches) {
                        const frame = match[0];
                        if (!stackPatterns.includes(frame) && frame.length > 3) {
                            stackPatterns.push(frame);
                        }
                    }
                }
            }
        }
    }
    
    // Second pass: General pattern search
    for (let offset = 0; offset < searchLimit; offset += chunkSize) {
        const chunkEnd = Math.min(offset + chunkSize, buffer.byteLength);
        const chunk = new Uint8Array(buffer, offset, chunkEnd - offset);
        const text = decoder.decode(chunk);
        
        for (const pattern of patterns) {
            const matches = text.matchAll(pattern);
            for (const match of matches) {
                const frame = match[0];
                // Filter out noise
                if (!stackPatterns.includes(frame) && 
                    frame.length > 3 && 
                    !frame.match(/^0x0+$/) && // Skip null addresses
                    !frame.match(/\.(txt|log|ini|dll)$/i)) { // Skip non-driver files
                    stackPatterns.push(frame);
                    if (stackPatterns.length >= 50) return stackPatterns.slice(0, 30); // Return top 30
                }
            }
        }
    }
    
    // Sort frames to put most relevant ones first
    return stackPatterns.sort((a, b) => {
        // Prioritize frames with function names
        const aHasFunc = a.includes('!');
        const bHasFunc = b.includes('!');
        if (aHasFunc && !bHasFunc) return -1;
        if (!aHasFunc && bHasFunc) return 1;
        
        // Prioritize kernel functions
        const aIsKernel = a.startsWith('nt!') || a.startsWith('hal!');
        const bIsKernel = b.startsWith('nt!') || b.startsWith('hal!');
        if (aIsKernel && !bIsKernel) return -1;
        if (!aIsKernel && bIsKernel) return 1;
        
        return 0;
    }).slice(0, 30);
}

function findOffsetInBuffer(buffer: ArrayBuffer, address: bigint): number {
    // This is a simplified search - in reality would need to map virtual to physical addresses
    return -1;
}

function findSymbolForAddress(buffer: ArrayBuffer, address: bigint): string | null {
    // Search for nearby strings that look like function names
    const searchStart = Number(address & BigInt('0xFFFFFFFF')) % buffer.byteLength;
    const nearbyString = extractNearbyString(buffer, searchStart, 256);
    
    if (nearbyString && nearbyString.match(/^[A-Za-z_][A-Za-z0-9_]*$/)) {
        return `nt!${nearbyString}+0x${(address & BigInt('0xFFF')).toString(16)}`;
    }
    
    return null;
}

function extractNearbyString(buffer: ArrayBuffer, offset: number, maxLength: number): string | null {
    const view = new Uint8Array(buffer);
    const start = Math.max(0, offset - maxLength / 2);
    const end = Math.min(buffer.byteLength, offset + maxLength / 2);
    
    let str = '';
    for (let i = start; i < end; i++) {
        const byte = view[i];
        if (byte >= 32 && byte <= 126) {
            str += String.fromCharCode(byte);
        } else if (str.length >= 4) {
            // Found a string of reasonable length
            return str;
        } else {
            str = '';
        }
    }
    
    return str.length >= 4 ? str : null;
}

export function getStructuredDumpInfo(buffer: ArrayBuffer, strings: string): StructuredDumpInfo {
    const structuredInfo: StructuredDumpInfo = {
        dumpHeader: extractDumpHeader(buffer),
        exceptionInfo: extractExceptionInfo(buffer),
        bugCheckInfo: extractBugCheckInfo(buffer),
        moduleList: extractModuleList(buffer, strings),
        threadContext: extractThreadContext(buffer),
    };
    
    // Cross-validate the extracted information
    if (structuredInfo.moduleList.length > 0) {
        const moduleValidation = DumpValidator.validateModuleAddresses(structuredInfo.moduleList);
        if (moduleValidation.length > 0) {
            console.warn('Module validation errors:', moduleValidation);
        }
    }
    
    // If this is a minidump, use the comprehensive parser for better accuracy
    const view = new DataView(buffer);
    if (buffer.byteLength >= 32 && view.getUint32(0, true) === 0x504D444D) { // 'MDMP'
        try {
            const parser = new MinidumpParser(buffer);
            
            // Override with more accurate data from MinidumpParser
            const minidumpModules = parser.getModules();
            if (minidumpModules.length > 0) {
                structuredInfo.moduleList = minidumpModules.map(m => ({
                    name: m.name,
                    base: m.baseAddress,
                    size: m.sizeOfImage,
                    timestamp: m.timeDateStamp,
                    checksum: m.checkSum,
                }));
            }
            
            const minidumpThreads = parser.getThreads();
            if (minidumpThreads.length > 0 && minidumpThreads[0].instructionPointer !== 0n) {
                structuredInfo.threadContext = {
                    threadId: minidumpThreads[0].threadId,
                    rip: minidumpThreads[0].instructionPointer,
                    rsp: minidumpThreads[0].stackPointer,
                    rbp: minidumpThreads[0].framePointer,
                    cr3: structuredInfo.dumpHeader?.directoryTableBase,
                    priority: minidumpThreads[0].priority,
                };
            }
            
            const minidumpException = parser.getException();
            if (minidumpException) {
                structuredInfo.exceptionInfo = {
                    code: minidumpException.exceptionCode,
                    name: EXCEPTION_CODES[minidumpException.exceptionCode] || 'UNKNOWN_EXCEPTION',
                    address: minidumpException.exceptionAddress,
                    parameter1: minidumpException.exceptionInformation[0] || 0n,
                    parameter2: minidumpException.exceptionInformation[1] || 0n,
                    flags: minidumpException.exceptionFlags,
                };
            }
        } catch (e) {
            console.error('MinidumpParser enhancement failed:', e);
        }
    }
    
    return structuredInfo;
}

// Export alias for compatibility
export { isLegitimateModuleName as isLegitimateDriver };