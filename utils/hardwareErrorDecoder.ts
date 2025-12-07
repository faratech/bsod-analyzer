/**
 * Hardware Error Decoder
 * Decodes Machine Check Exception (MCE) and Windows Hardware Error Architecture (WHEA) errors
 * For bug checks 0x124 (WHEA_UNCORRECTABLE_ERROR), 0x9C (MACHINE_CHECK_EXCEPTION), etc.
 */

export interface MCEDecodedError {
    errorType: string;
    severity: 'fatal' | 'recoverable' | 'corrected' | 'deferred';
    component: string;
    description: string;
    details: string[];
    recommendations: string[];
}

export interface WHEAErrorRecord {
    errorSource: string;
    errorType: string;
    component: string;
    bank?: number;
    mciStatus?: bigint;
    decodedError?: MCEDecodedError;
}

// MCE Error Types (based on Intel/AMD specifications)
const MCE_ERROR_TYPES: Record<number, string> = {
    0x0000: 'No Error',
    0x0001: 'Unclassified Error',
    0x0002: 'Microcode ROM Parity Error',
    0x0003: 'External Error',
    0x0004: 'FRC Error',
    0x0005: 'Internal Parity Error',
    0x0006: 'SMM Handler Code Access Violation',

    // TLB Errors (0x000X where X=level)
    0x0010: 'ITLB Error',
    0x0011: 'DTLB Error',
    0x0012: 'STLB Error',

    // Cache Errors
    0x0100: 'Level 0 Cache Data Error',
    0x0101: 'Level 1 Cache Data Error',
    0x0102: 'Level 2 Cache Data Error',
    0x0103: 'Level 3 Cache Data Error',
    0x0104: 'Generic Cache Error',
    0x0110: 'Level 0 Cache Instruction Error',
    0x0111: 'Level 1 Cache Instruction Error',
    0x0112: 'Level 2 Cache Instruction Error',

    // Bus/Interconnect Errors
    0x0800: 'Bus Error - Local',
    0x0801: 'Bus Error - Remote',
    0x0802: 'Bus Error - Timeout',
    0x0803: 'Bus Error - Parity',
    0x0804: 'Bus Error - Protocol',
    0x0805: 'Bus Error - Data',
    0x0806: 'Bus Error - Generic',

    // Memory Controller Errors
    0x0E00: 'Memory Controller Error',
    0x0E01: 'Memory Read Error',
    0x0E02: 'Memory Write Error',
    0x0E03: 'Memory Address/Command Error',
    0x0E04: 'Memory Scrub Error',
};

// WHEA Error Source Types
const WHEA_ERROR_SOURCES: Record<number, string> = {
    0: 'Machine Check Exception',
    1: 'Corrected Machine Check',
    2: 'Corrected Platform Error',
    3: 'Non-Maskable Interrupt',
    4: 'PCI Express Error',
    5: 'Other Hardware Error',
    6: 'IA32/x64 Boot Error',
    7: 'Generic Hardware Error',
    8: 'INIT Error',
    9: 'GHES Source (ACPI)',
    10: 'PCI Express AER Root Port',
    11: 'PCI Express AER Endpoint',
    12: 'PCI Express AER Bridge',
    13: 'Generic Error (v2)'
};

/**
 * Decode MCI_STATUS register format
 * Bits 63: VAL (Valid)
 * Bits 62: OVER (Overflow)
 * Bits 61: UC (Uncorrected)
 * Bits 60: EN (Error Enabled)
 * Bits 59: MISCV (MISC Valid)
 * Bits 58: ADDRV (ADDR Valid)
 * Bits 57: PCC (Processor Context Corrupt)
 * Bits 56-55: Reserved
 * Bits 54-53: AR (Error recovery is required)
 * Bits 52: S (Signaling an UCR error)
 * Bits 51-32: Reserved / Extended Error Code (AMD)
 * Bits 31-16: Model Specific Error Code
 * Bits 15-0: MCA Error Code
 */
export function decodeMciStatus(mciStatus: bigint): MCEDecodedError {
    const valid = (mciStatus >> 63n) & 1n;
    const overflow = (mciStatus >> 62n) & 1n;
    const uncorrected = (mciStatus >> 61n) & 1n;
    // Bit 60: Error Enabled - not used in decoding
    const miscValid = (mciStatus >> 59n) & 1n;
    const addrValid = (mciStatus >> 58n) & 1n;
    const pcc = (mciStatus >> 57n) & 1n;
    const recoverable = (mciStatus >> 54n) & 1n;

    const modelSpecificCode = Number((mciStatus >> 16n) & 0xFFFFn);
    const mcaErrorCode = Number(mciStatus & 0xFFFFn);

    // Determine severity
    let severity: 'fatal' | 'recoverable' | 'corrected' | 'deferred';
    if (uncorrected === 1n && pcc === 1n) {
        severity = 'fatal';
    } else if (uncorrected === 1n && recoverable === 1n) {
        severity = 'recoverable';
    } else if (uncorrected === 1n) {
        severity = 'deferred';
    } else {
        severity = 'corrected';
    }

    // Decode MCA error code
    const errorType = decodeMCAErrorCode(mcaErrorCode);
    const component = determineComponent(mcaErrorCode);

    const details: string[] = [];
    details.push(`MCI_STATUS: 0x${mciStatus.toString(16).padStart(16, '0')}`);
    details.push(`Valid: ${valid === 1n ? 'Yes' : 'No'}`);
    details.push(`Uncorrected: ${uncorrected === 1n ? 'Yes' : 'No'}`);
    details.push(`Overflow: ${overflow === 1n ? 'Yes (multiple errors)' : 'No'}`);
    details.push(`Context Corrupt: ${pcc === 1n ? 'Yes' : 'No'}`);
    if (addrValid === 1n) {
        details.push('Address information available in MCI_ADDR');
    }
    if (miscValid === 1n) {
        details.push('Additional information available in MCI_MISC');
    }
    details.push(`Model-specific code: 0x${modelSpecificCode.toString(16)}`);
    details.push(`MCA error code: 0x${mcaErrorCode.toString(16)}`);

    const recommendations = getHardwareRecommendations(errorType, severity, component);

    return {
        errorType,
        severity,
        component,
        description: `${severity.toUpperCase()} ${errorType} in ${component}`,
        details,
        recommendations
    };
}

/**
 * Decode MCA Error Code (bits 15-0 of MCI_STATUS)
 */
function decodeMCAErrorCode(code: number): string {
    // Simple Error Codes (0000-00FFh)
    if (code === 0) {
        return 'No Error';
    }

    // TLB Errors (0001Xh-001Fh)
    if ((code & 0xFFF0) === 0x0010) {
        const tt = (code >> 2) & 0x3; // Transaction type
        const ll = code & 0x3; // Level
        const ttStr = ['Instruction', 'Data', 'Generic', 'Reserved'][tt];
        const llStr = ['L0', 'L1', 'L2', 'Generic'][ll];
        return `TLB ${ttStr} Error (${llStr})`;
    }

    // Memory Hierarchy Errors (0001XXh)
    if ((code & 0xFF00) === 0x0100) {
        const tt = (code >> 2) & 0x3;
        const ll = code & 0x3;
        const rrrr = (code >> 4) & 0xF;

        const ttStr = ['Instruction', 'Data', 'Generic', 'Reserved'][tt];
        const llStr = ['L0/Execution Unit', 'L1', 'L2', 'L3/Generic'][ll];
        const rrrrStr: Record<number, string> = {
            0: 'Generic',
            1: 'Generic Read',
            2: 'Generic Write',
            3: 'Data Read',
            4: 'Data Write',
            5: 'Instruction Fetch',
            6: 'Prefetch',
            7: 'Eviction',
            8: 'Snoop'
        };

        return `Cache ${rrrrStr[rrrr] || 'Unknown'} Error (${llStr} ${ttStr})`;
    }

    // Bus/Interconnect Errors (0000 1XXXh)
    if ((code & 0xF800) === 0x0800) {
        const pp = (code >> 9) & 0x3; // Participation
        const t = (code >> 8) & 0x1;  // Timeout
        const ll = code & 0x3;

        const ppStr = ['Local processor', 'Responding to request', 'Observing', 'Generic'][pp];
        const llStr = ['L0', 'L1', 'L2', 'Generic'][ll];

        let desc = `Bus Error - ${ppStr}`;
        if (t) desc += ' (Timeout)';
        desc += ` at ${llStr}`;

        return desc;
    }

    // Memory Controller Errors
    if ((code & 0xF000) === 0xE000) {
        return 'Memory Controller Error';
    }

    // Check predefined error types
    if (MCE_ERROR_TYPES[code]) {
        return MCE_ERROR_TYPES[code];
    }

    return `Unknown MCA Error (0x${code.toString(16)})`;
}

/**
 * Determine the hardware component from error code
 */
function determineComponent(mcaErrorCode: number): string {
    if ((mcaErrorCode & 0xFFF0) === 0x0010) {
        return 'Translation Lookaside Buffer (TLB)';
    }
    if ((mcaErrorCode & 0xFF00) === 0x0100) {
        const ll = mcaErrorCode & 0x3;
        const levels = ['Execution Unit', 'L1 Cache', 'L2 Cache', 'L3 Cache'];
        return levels[ll] || 'CPU Cache';
    }
    if ((mcaErrorCode & 0xF800) === 0x0800) {
        return 'System Bus/Interconnect';
    }
    if ((mcaErrorCode & 0xF000) === 0xE000) {
        return 'Memory Controller';
    }
    return 'Unknown Component';
}

/**
 * Get hardware-specific recommendations
 */
function getHardwareRecommendations(
    _errorType: string,
    severity: 'fatal' | 'recoverable' | 'corrected' | 'deferred',
    component: string
): string[] {
    const recs: string[] = [];

    // Universal recommendations
    recs.push('Update BIOS/UEFI firmware to latest version');
    recs.push('Update CPU microcode (usually included in BIOS updates)');

    // Severity-based recommendations
    if (severity === 'fatal' || severity === 'recoverable') {
        recs.push('Stop using the system until hardware issue is resolved');
        recs.push('Back up critical data immediately');
    }

    // Component-specific recommendations
    if (component.includes('Cache')) {
        recs.push('Disable CPU overclocking immediately');
        recs.push('Check CPU temperatures - may indicate overheating');
        recs.push('Reset BIOS to default settings');
        recs.push('If errors persist, CPU may be failing');
    }

    if (component.includes('TLB')) {
        recs.push('TLB errors often indicate CPU issues');
        recs.push('Check for CPU thermal throttling');
        recs.push('Disable Hyper-Threading temporarily to test');
    }

    if (component.includes('Memory Controller')) {
        recs.push('Test RAM with MemTest86+ for extended period (8+ hours)');
        recs.push('Try running with single RAM stick at a time');
        recs.push('Disable XMP/DOCP memory profiles');
        recs.push('Check RAM seating and clean contacts');
        recs.push('Memory controller is on CPU - could indicate CPU issue');
    }

    if (component.includes('Bus') || component.includes('Interconnect')) {
        recs.push('Check motherboard for physical damage or bulging capacitors');
        recs.push('Verify power supply stability');
        recs.push('Check PCIe slot seating for all cards');
        recs.push('Could indicate motherboard or power supply issue');
    }

    return recs;
}

/**
 * Decode WHEA bug check parameters (0x124 WHEA_UNCORRECTABLE_ERROR)
 * Param1: Error source type
 * Param2: Address of WHEA_ERROR_RECORD structure
 * Param3: High 32 bits of MCi_STATUS MSR (for MCE sources)
 * Param4: Low 32 bits of MCi_STATUS MSR (for MCE sources)
 */
export function decodeWHEABugCheck(
    param1: bigint,
    _param2: bigint, // Address of WHEA_ERROR_RECORD - not directly usable in client
    param3: bigint,
    param4: bigint
): WHEAErrorRecord {
    const errorSourceType = Number(param1);
    const errorSource = WHEA_ERROR_SOURCES[errorSourceType] || `Unknown Source (${errorSourceType})`;

    // Reconstruct MCI_STATUS from params 3 and 4
    const mciStatus = (param3 << 32n) | param4;

    const result: WHEAErrorRecord = {
        errorSource,
        errorType: 'Hardware Error',
        component: 'Unknown',
    };

    // For MCE sources, decode the MCI_STATUS
    if (errorSourceType === 0 || errorSourceType === 1) {
        result.mciStatus = mciStatus;
        result.decodedError = decodeMciStatus(mciStatus);
        result.errorType = result.decodedError.errorType;
        result.component = result.decodedError.component;
    } else if (errorSourceType === 4 || errorSourceType === 10 || errorSourceType === 11) {
        // PCIe error
        result.errorType = 'PCI Express Error';
        result.component = 'PCIe Device or Bus';
        result.decodedError = {
            errorType: 'PCI Express Error',
            severity: 'fatal',
            component: 'PCIe',
            description: 'A PCIe device reported an uncorrectable error',
            details: [
                'This could be a failing PCIe device (GPU, NVMe, network card)',
                'Check all PCIe cards are properly seated',
                'Check for PCIe slot or motherboard issues'
            ],
            recommendations: [
                'Reseat all PCIe devices',
                'Test with one PCIe device at a time',
                'Try the suspected device in a different slot',
                'Check device driver and firmware updates',
                'If GPU, check power connectors and PSU capacity'
            ]
        };
    } else if (errorSourceType === 3) {
        // NMI
        result.errorType = 'Non-Maskable Interrupt';
        result.component = 'System Hardware';
        result.decodedError = {
            errorType: 'Non-Maskable Interrupt',
            severity: 'fatal',
            component: 'System',
            description: 'Hardware NMI triggered - critical hardware failure',
            details: [
                'NMI can indicate serious hardware problems',
                'Often caused by parity errors or hardware watchdogs'
            ],
            recommendations: [
                'Check system event log for hardware errors',
                'Test RAM with MemTest86+',
                'Check power supply health',
                'Inspect motherboard for damage',
                'Check all cable connections'
            ]
        };
    }

    return result;
}

/**
 * Decode Machine Check Exception bug check (0x9C)
 * Param1: Bank number
 * Param2: Address of MCA_EXCEPTION structure
 * Param3: High 32 bits of MCi_STATUS MSR
 * Param4: Low 32 bits of MCi_STATUS MSR
 */
export function decodeMCEBugCheck(
    param1: bigint,
    _param2: bigint, // Address of MCA_EXCEPTION - not directly usable in client
    param3: bigint,
    param4: bigint
): WHEAErrorRecord {
    const bank = Number(param1);
    const mciStatus = (param3 << 32n) | param4;
    const decodedError = decodeMciStatus(mciStatus);

    // Add bank-specific information
    const bankNames: Record<number, string> = {
        0: 'Data Cache',
        1: 'Instruction Cache',
        2: 'Bus/Interconnect',
        3: 'Load/Store Unit',
        4: 'L2 Cache',
        5: 'Execution Unit',
        6: 'Floating Point Unit',
        7: 'L3 Cache',
    };

    const bankDescription = bankNames[bank] || `MCE Bank ${bank}`;

    return {
        errorSource: 'Machine Check Exception',
        errorType: decodedError.errorType,
        component: `${bankDescription} - ${decodedError.component}`,
        bank,
        mciStatus,
        decodedError: {
            ...decodedError,
            details: [
                `MCE Bank: ${bank} (${bankDescription})`,
                ...decodedError.details
            ]
        }
    };
}

/**
 * Decode UNEXPECTED_KERNEL_MODE_TRAP (0x7F)
 * Param1 is the trap number
 */
export function decodeKernelTrap(trapNumber: bigint): {
    trapName: string;
    description: string;
    likelyHardware: boolean;
    recommendations: string[];
} {
    const trap = Number(trapNumber);

    const traps: Record<number, { name: string; desc: string; hw: boolean }> = {
        0x00: { name: 'Divide Error', desc: 'Integer division by zero or overflow', hw: false },
        0x01: { name: 'Debug Exception', desc: 'Debug breakpoint or single-step', hw: false },
        0x02: { name: 'NMI', desc: 'Non-Maskable Interrupt (hardware failure)', hw: true },
        0x03: { name: 'Breakpoint', desc: 'INT 3 instruction', hw: false },
        0x04: { name: 'Overflow', desc: 'INTO instruction with OF=1', hw: false },
        0x05: { name: 'Bounds Check', desc: 'BOUND instruction range exceeded', hw: false },
        0x06: { name: 'Invalid Opcode', desc: 'Invalid/undefined instruction', hw: false },
        0x07: { name: 'Device Not Available', desc: 'FPU/MMX not available', hw: false },
        0x08: { name: 'Double Fault', desc: 'Exception during exception handling', hw: true },
        0x09: { name: 'Coprocessor Segment Overrun', desc: 'Legacy 387 segment overrun', hw: false },
        0x0A: { name: 'Invalid TSS', desc: 'Invalid Task State Segment', hw: false },
        0x0B: { name: 'Segment Not Present', desc: 'Segment not present in memory', hw: false },
        0x0C: { name: 'Stack Fault', desc: 'Stack segment fault', hw: false },
        0x0D: { name: 'General Protection', desc: 'General protection violation', hw: false },
        0x0E: { name: 'Page Fault', desc: 'Page not present or protection violation', hw: false },
        0x10: { name: 'x87 FPU Error', desc: 'x87 floating-point exception', hw: false },
        0x11: { name: 'Alignment Check', desc: 'Unaligned memory access', hw: false },
        0x12: { name: 'Machine Check', desc: 'Machine check exception (hardware)', hw: true },
        0x13: { name: 'SIMD Exception', desc: 'SSE/AVX floating-point exception', hw: false },
    };

    const trapInfo = traps[trap] || { name: `Unknown Trap ${trap}`, desc: 'Unknown exception', hw: false };

    const recommendations: string[] = [];

    if (trapInfo.hw) {
        recommendations.push('This is likely a HARDWARE issue');
        recommendations.push('Test RAM with MemTest86+');
        recommendations.push('Check CPU temperature and cooling');
        recommendations.push('Disable any overclocking');
        recommendations.push('Update BIOS/UEFI firmware');
    } else {
        recommendations.push('This could be a driver or software issue');
        recommendations.push('Update all drivers');
        recommendations.push('Check for recently installed software');
        recommendations.push('If recurring, hardware testing is still advised');
    }

    if (trap === 0x08) { // Double Fault
        recommendations.push('Double Fault is severe - often indicates failing hardware');
        recommendations.push('Check motherboard capacitors for bulging');
        recommendations.push('Test power supply stability');
    }

    if (trap === 0x02 || trap === 0x12) { // NMI or Machine Check
        recommendations.push('Run comprehensive hardware diagnostics');
        recommendations.push('Check system event log for hardware errors');
    }

    return {
        trapName: trapInfo.name,
        description: trapInfo.desc,
        likelyHardware: trapInfo.hw,
        recommendations
    };
}

/**
 * Check if a bug check indicates hardware failure
 */
export function isHardwareBugCheck(bugCheckCode: number): boolean {
    const hardwareBugChecks = [
        0x0000009C, // MACHINE_CHECK_EXCEPTION
        0x00000124, // WHEA_UNCORRECTABLE_ERROR
        0x0000007F, // UNEXPECTED_KERNEL_MODE_TRAP (some cases)
        0x0000002E, // DATA_BUS_ERROR
        0x00000101, // CLOCK_WATCHDOG_TIMEOUT
        0x0000004E, // PFN_LIST_CORRUPT (often hardware)
        0x0000001A, // MEMORY_MANAGEMENT (often hardware)
    ];

    return hardwareBugChecks.includes(bugCheckCode);
}
