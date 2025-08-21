// Enhanced binary structure definitions for accurate BSOD parsing
// Based on Windows kernel structures and dump file formats

export interface MINIDUMP_HEADER {
    signature: number;              // 'MDMP'
    version: number;
    numberOfStreams: number;
    streamDirectoryRva: number;
    checksum: number;
    timestamp: number;
    flags: bigint;
}

export interface DUMP_HEADER64 {
    signature: string;              // 'PAGEDUMP' or 'PAGEDU64'
    validDump: string;              // 'DUMP' or 'DU64'
    majorVersion: number;
    minorVersion: number;
    directoryTableBase: bigint;
    pfnDatabase: bigint;
    psLoadedModuleList: bigint;
    psActiveProcessHead: bigint;
    machineImageType: number;
    numberOfProcessors: number;
    bugCheckCode: number;
    bugCheckParameter1: bigint;
    bugCheckParameter2: bigint;
    bugCheckParameter3: bigint;
    bugCheckParameter4: bigint;
    versionUser: string;
    kdDebuggerDataBlock: bigint;
    physicalMemoryBlock: PHYSICAL_MEMORY_DESCRIPTOR;
    contextRecord: Uint8Array;      // CONTEXT structure
    exception: EXCEPTION_RECORD64;
}

export interface PHYSICAL_MEMORY_DESCRIPTOR {
    numberOfRuns: number;
    numberOfPages: bigint;
    runs: Array<{
        basePage: bigint;
        pageCount: bigint;
    }>;
}

export interface EXCEPTION_RECORD64 {
    exceptionCode: number;
    exceptionFlags: number;
    exceptionRecord: bigint;
    exceptionAddress: bigint;
    numberOfParameters: number;
    exceptionInformation: bigint[];
}

export interface CONTEXT_AMD64 {
    p1Home: bigint;
    p2Home: bigint;
    p3Home: bigint;
    p4Home: bigint;
    p5Home: bigint;
    p6Home: bigint;
    contextFlags: number;
    mxCsr: number;
    segCs: number;
    segDs: number;
    segEs: number;
    segFs: number;
    segGs: number;
    segSs: number;
    eFlags: number;
    dr0: bigint;
    dr1: bigint;
    dr2: bigint;
    dr3: bigint;
    dr6: bigint;
    dr7: bigint;
    rax: bigint;
    rcx: bigint;
    rdx: bigint;
    rbx: bigint;
    rsp: bigint;
    rbp: bigint;
    rsi: bigint;
    rdi: bigint;
    r8: bigint;
    r9: bigint;
    r10: bigint;
    r11: bigint;
    r12: bigint;
    r13: bigint;
    r14: bigint;
    r15: bigint;
    rip: bigint;
}

export interface KLDR_DATA_TABLE_ENTRY {
    inLoadOrderLinks: LIST_ENTRY;
    exceptionTable: bigint;
    exceptionTableSize: number;
    gateAddress: bigint;
    nonPagedDebugInfo: bigint;
    dllBase: bigint;
    entryPoint: bigint;
    sizeOfImage: number;
    fullDllName: UNICODE_STRING;
    baseDllName: UNICODE_STRING;
    flags: number;
    loadCount: number;
    signatureLevel: number;
    signatureType: number;
    loadTime: bigint;
}

export interface LIST_ENTRY {
    flink: bigint;
    blink: bigint;
}

export interface UNICODE_STRING {
    length: number;
    maximumLength: number;
    buffer: bigint;
}

export interface KTHREAD {
    header: DISPATCHER_HEADER;
    mutantListHead: LIST_ENTRY;
    initialStack: bigint;
    stackLimit: bigint;
    stackBase: bigint;
    threadLock: number;
    waitIrql: number;
    waitMode: number;
    waitStatus: number;
    waitBlockList: bigint;
    alertable: boolean;
    waitNext: boolean;
    waitReason: number;
    priority: number;
    enableStackSwap: boolean;
    volatileState: number;
}

export interface DISPATCHER_HEADER {
    type: number;
    signalState: number;
    size: number;
    reserved: number;
}

export interface KPRCB {
    minorVersion: number;
    majorVersion: number;
    currentThread: bigint;
    nextThread: bigint;
    idleThread: bigint;
    number: number;
    buildType: number;
    cpuType: number;
    cpuID: number;
    cpuStep: number;
    processorState: KPROCESSOR_STATE;
    cpuSpeed: number;
    halReserved: bigint[];
    processorFeatures: Uint8Array;
}

export interface KPROCESSOR_STATE {
    contextFrame: CONTEXT_AMD64;
    specialRegisters: KSPECIAL_REGISTERS;
}

export interface KSPECIAL_REGISTERS {
    cr0: bigint;
    cr2: bigint;
    cr3: bigint;
    cr4: bigint;
    cr8: bigint;
    debugControl: bigint;
    lastException: bigint;
    idtr: bigint;
    gdtr: bigint;
    tr: number;
    ldtr: number;
}

// Memory pool structures
export interface POOL_HEADER {
    previousSize: number;
    poolIndex: number;
    blockSize: number;
    poolType: number;
    poolTag: number;
    processBilled: bigint;
}

// PTE structures for memory analysis
export interface MMPTE_HARDWARE {
    valid: boolean;
    write: boolean;
    owner: boolean;
    writeThrough: boolean;
    cacheDisable: boolean;
    accessed: boolean;
    dirty: boolean;
    largePage: boolean;
    global: boolean;
    copyOnWrite: boolean;
    prototype: boolean;
    reserved: boolean;
    pageFrameNumber: bigint;
}

// Driver verification structures
export interface IMAGE_DOS_HEADER {
    e_magic: number;    // 'MZ'
    e_cblp: number;
    e_cp: number;
    e_crlc: number;
    e_cparhdr: number;
    e_minalloc: number;
    e_maxalloc: number;
    e_ss: number;
    e_sp: number;
    e_csum: number;
    e_ip: number;
    e_cs: number;
    e_lfarlc: number;
    e_ovno: number;
    e_res: number[];
    e_oemid: number;
    e_oeminfo: number;
    e_res2: number[];
    e_lfanew: number;
}

export interface IMAGE_NT_HEADERS64 {
    signature: number;  // 'PE\0\0'
    fileHeader: IMAGE_FILE_HEADER;
    optionalHeader: IMAGE_OPTIONAL_HEADER64;
}

export interface IMAGE_FILE_HEADER {
    machine: number;
    numberOfSections: number;
    timeDateStamp: number;
    pointerToSymbolTable: number;
    numberOfSymbols: number;
    sizeOfOptionalHeader: number;
    characteristics: number;
}

export interface IMAGE_OPTIONAL_HEADER64 {
    magic: number;
    majorLinkerVersion: number;
    minorLinkerVersion: number;
    sizeOfCode: number;
    sizeOfInitializedData: number;
    sizeOfUninitializedData: number;
    addressOfEntryPoint: number;
    baseOfCode: number;
    imageBase: bigint;
    sectionAlignment: number;
    fileAlignment: number;
    majorOperatingSystemVersion: number;
    minorOperatingSystemVersion: number;
    majorImageVersion: number;
    minorImageVersion: number;
    majorSubsystemVersion: number;
    minorSubsystemVersion: number;
    win32VersionValue: number;
    sizeOfImage: number;
    sizeOfHeaders: number;
    checkSum: number;
    subsystem: number;
    dllCharacteristics: number;
    sizeOfStackReserve: bigint;
    sizeOfStackCommit: bigint;
    sizeOfHeapReserve: bigint;
    sizeOfHeapCommit: bigint;
    loaderFlags: number;
    numberOfRvaAndSizes: number;
    dataDirectory: IMAGE_DATA_DIRECTORY[];
}

export interface IMAGE_DATA_DIRECTORY {
    virtualAddress: number;
    size: number;
}

// Helper constants
export const CONTEXT_AMD64_CONTROL = 0x00100001;
export const CONTEXT_AMD64_INTEGER = 0x00100002;
export const CONTEXT_AMD64_SEGMENTS = 0x00100004;
export const CONTEXT_AMD64_FLOATING_POINT = 0x00100008;
export const CONTEXT_AMD64_DEBUG_REGISTERS = 0x00100010;
export const CONTEXT_AMD64_FULL = CONTEXT_AMD64_CONTROL | CONTEXT_AMD64_INTEGER | CONTEXT_AMD64_FLOATING_POINT;

export const PAGE_SIZE = 4096;
export const LARGE_PAGE_SIZE = 2097152; // 2MB
export const PTE_SHIFT = 9;
export const PDE_SHIFT = 18;
export const PDPTE_SHIFT = 27;
export const PML4E_SHIFT = 36;

// Pool tags for common drivers
export const POOL_TAGS: Record<number, string> = {
    0x636F7250: 'Proc - Process objects',
    0x61657254: 'Trea - Thread objects',
    0x20656C69: 'File - File objects',
    0x6C6F6F50: 'Pool - Pool tables',
    0x65766952: 'Rive - Driver objects',
    0x20657669: 'Ive  - I/O verification',
    0x6F4C6D4D: 'MmLo - Memory manager loader',
    0x636F536E: 'nSoc - Network sockets',
    0x62754875: 'HuBu - USB hub',
    0x20555043: 'CPU  - CPU structures',
};

// Machine types
export const MACHINE_TYPES: Record<number, string> = {
    0x014C: 'x86',
    0x0200: 'IA64',
    0x8664: 'x64',
    0xAA64: 'ARM64',
    0x01C0: 'ARM',
    0x01C2: 'ARM Thumb',
    0x01C4: 'ARM Thumb-2',
};

// Exception codes (comprehensive list)
export const EXCEPTION_CODES: Record<number, string> = {
    0x80000001: 'GUARD_PAGE_VIOLATION',
    0x80000002: 'DATATYPE_MISALIGNMENT',
    0x80000003: 'BREAKPOINT',
    0x80000004: 'SINGLE_STEP',
    0xC0000005: 'ACCESS_VIOLATION',
    0xC0000006: 'IN_PAGE_ERROR',
    0xC0000008: 'INVALID_HANDLE',
    0xC000000D: 'INVALID_PARAMETER',
    0xC0000017: 'NO_MEMORY',
    0xC000001D: 'ILLEGAL_INSTRUCTION',
    0xC0000025: 'NONCONTINUABLE_EXCEPTION',
    0xC0000026: 'INVALID_DISPOSITION',
    0xC000008C: 'ARRAY_BOUNDS_EXCEEDED',
    0xC000008D: 'FLOAT_DENORMAL_OPERAND',
    0xC000008E: 'FLOAT_DIVIDE_BY_ZERO',
    0xC000008F: 'FLOAT_INEXACT_RESULT',
    0xC0000090: 'FLOAT_INVALID_OPERATION',
    0xC0000091: 'FLOAT_OVERFLOW',
    0xC0000092: 'FLOAT_STACK_CHECK',
    0xC0000093: 'FLOAT_UNDERFLOW',
    0xC0000094: 'INTEGER_DIVIDE_BY_ZERO',
    0xC0000095: 'INTEGER_OVERFLOW',
    0xC0000096: 'PRIVILEGED_INSTRUCTION',
    0xC00000FD: 'STACK_OVERFLOW',
    0xC0000135: 'DLL_NOT_FOUND',
    0xC0000142: 'DLL_INIT_FAILED',
    0xC0000194: 'POSSIBLE_DEADLOCK',
    0xC0000374: 'HEAP_CORRUPTION',
    0xC0000409: 'STACK_BUFFER_OVERRUN',
    0xC0000417: 'INVALID_CRUNTIME_PARAMETER',
    0xC06D007E: 'MODULE_NOT_FOUND',
    0xC06D007F: 'PROCEDURE_NOT_FOUND',
};

// IRQL levels
export const IRQL_LEVELS: Record<number, string> = {
    0: 'PASSIVE_LEVEL',
    1: 'APC_LEVEL',
    2: 'DISPATCH_LEVEL',
    3: 'CMCI_LEVEL',
    4: 'DEVICE_LEVEL_BASE',
    5: 'PC_LEVEL',
    6: 'PERFORMANCE_LEVEL',
    7: 'CLOCK_LEVEL',
    8: 'IPI_LEVEL',
    9: 'DRS_LEVEL',
    10: 'POWER_LEVEL',
    11: 'HIGH_LEVEL',
};

// Thread wait reasons
export const WAIT_REASONS: Record<number, string> = {
    0: 'Executive',
    1: 'FreePage',
    2: 'PageIn',
    3: 'PoolAllocation',
    4: 'DelayExecution',
    5: 'Suspended',
    6: 'UserRequest',
    7: 'WrExecutive',
    8: 'WrFreePage',
    9: 'WrPageIn',
    10: 'WrPoolAllocation',
    11: 'WrDelayExecution',
    12: 'WrSuspended',
    13: 'WrUserRequest',
    14: 'WrEventPair',
    15: 'WrQueue',
    16: 'WrLpcReceive',
    17: 'WrLpcReply',
    18: 'WrVirtualMemory',
    19: 'WrPageOut',
    20: 'WrRendezvous',
    21: 'WrKeyedEvent',
    22: 'WrTerminated',
    23: 'WrProcessInSwap',
    24: 'WrCpuRateControl',
    25: 'WrCalloutStack',
    26: 'WrKernel',
    27: 'WrResource',
    28: 'WrPushLock',
    29: 'WrMutex',
    30: 'WrQuantumEnd',
    31: 'WrDispatchInt',
    32: 'WrPreempted',
    33: 'WrYieldExecution',
    34: 'WrFastMutex',
    35: 'WrGuardedMutex',
    36: 'WrRundown',
    37: 'WrAlertByThreadId',
    38: 'WrDeferredPreempt',
};