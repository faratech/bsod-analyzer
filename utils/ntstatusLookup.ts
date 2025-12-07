/**
 * NTSTATUS Error Code Lookup
 * Decodes common Windows NTSTATUS codes appearing in crash dump parameters
 *
 * NTSTATUS format:
 * Bits 31-30: Severity (00=Success, 01=Informational, 10=Warning, 11=Error)
 * Bit 29: Customer bit (0=Microsoft, 1=Customer defined)
 * Bit 28: Reserved
 * Bits 27-16: Facility code
 * Bits 15-0: Error code
 */

export interface NtStatusInfo {
    code: number;
    name: string;
    description: string;
    severity: 'success' | 'informational' | 'warning' | 'error';
    commonCauses?: string[];
    suggestedFix?: string;
}

// Common NTSTATUS codes seen in crash dumps
export const NTSTATUS_CODES: Record<number, NtStatusInfo> = {
    // === SUCCESS CODES (0x00000000 - 0x3FFFFFFF) ===
    0x00000000: {
        code: 0x00000000,
        name: 'STATUS_SUCCESS',
        description: 'The operation completed successfully.',
        severity: 'success'
    },
    0x00000102: {
        code: 0x00000102,
        name: 'STATUS_TIMEOUT',
        description: 'The operation timed out.',
        severity: 'success',
        commonCauses: ['Device not responding', 'Network timeout', 'Driver wait exceeded']
    },
    0x00000103: {
        code: 0x00000103,
        name: 'STATUS_PENDING',
        description: 'The operation is pending.',
        severity: 'success'
    },

    // === ERROR CODES (0xC0000000 and above) ===

    // Access Violations and Memory Errors
    0xC0000005: {
        code: 0xC0000005,
        name: 'STATUS_ACCESS_VIOLATION',
        description: 'An attempt was made to access an invalid memory address.',
        severity: 'error',
        commonCauses: [
            'NULL pointer dereference',
            'Use-after-free',
            'Buffer overflow',
            'Invalid pointer arithmetic',
            'Freed memory access'
        ],
        suggestedFix: 'Check the stack trace to identify the faulting code. Look for null checks and memory allocation issues.'
    },
    0xC0000006: {
        code: 0xC0000006,
        name: 'STATUS_IN_PAGE_ERROR',
        description: 'A page of memory could not be read from disk.',
        severity: 'error',
        commonCauses: [
            'Disk read failure',
            'Bad sectors on storage device',
            'Page file corruption',
            'Network drive disconnect (for network-backed files)'
        ],
        suggestedFix: 'Run chkdsk, check disk health with SMART tools, and verify storage connections.'
    },
    0xC0000008: {
        code: 0xC0000008,
        name: 'STATUS_INVALID_HANDLE',
        description: 'An invalid HANDLE was specified.',
        severity: 'error',
        commonCauses: [
            'Using a closed handle',
            'Handle corruption',
            'Race condition in handle usage',
            'Double-close of handle'
        ],
        suggestedFix: 'Enable handle tracing in Driver Verifier to identify the source.'
    },
    0xC000000D: {
        code: 0xC000000D,
        name: 'STATUS_INVALID_PARAMETER',
        description: 'An invalid parameter was passed to a service or function.',
        severity: 'error',
        commonCauses: [
            'Driver passing invalid arguments',
            'API misuse',
            'Corrupted data structures'
        ]
    },
    0xC000000E: {
        code: 0xC000000E,
        name: 'STATUS_NO_SUCH_DEVICE',
        description: 'A device which does not exist was specified.',
        severity: 'error',
        commonCauses: [
            'Hardware removed unexpectedly',
            'Driver for non-existent device',
            'Device path error'
        ]
    },
    0xC000000F: {
        code: 0xC000000F,
        name: 'STATUS_NO_SUCH_FILE',
        description: 'The specified file does not exist.',
        severity: 'error',
        commonCauses: [
            'File deleted or moved',
            'Path error',
            'File system corruption'
        ]
    },
    0xC0000010: {
        code: 0xC0000010,
        name: 'STATUS_INVALID_DEVICE_REQUEST',
        description: 'The specified request is not a valid operation for the target device.',
        severity: 'error',
        commonCauses: [
            'Driver sending wrong IOCTL',
            'Device capability mismatch',
            'Incorrect device mode'
        ]
    },

    // Stack and Memory Errors
    0xC00000FD: {
        code: 0xC00000FD,
        name: 'STATUS_STACK_OVERFLOW',
        description: 'A new guard page for the stack cannot be created.',
        severity: 'error',
        commonCauses: [
            'Infinite recursion',
            'Excessive stack allocation',
            'Deep call stacks',
            'Corrupted stack pointer'
        ],
        suggestedFix: 'Check for recursive function calls and reduce local variable sizes.'
    },
    0xC0000017: {
        code: 0xC0000017,
        name: 'STATUS_NO_MEMORY',
        description: 'There is not enough memory to complete the operation.',
        severity: 'error',
        commonCauses: [
            'Memory exhaustion',
            'Memory leak',
            'Large allocation request',
            'Pool depletion'
        ],
        suggestedFix: 'Check for memory leaks, increase system RAM, or increase page file size.'
    },
    0xC000009A: {
        code: 0xC000009A,
        name: 'STATUS_INSUFFICIENT_RESOURCES',
        description: 'Insufficient system resources exist to complete the API.',
        severity: 'error',
        commonCauses: [
            'Handle table full',
            'Paged pool exhaustion',
            'Non-paged pool exhaustion',
            'Resource leak'
        ]
    },
    0xC000009D: {
        code: 0xC000009D,
        name: 'STATUS_DEVICE_NOT_CONNECTED',
        description: 'The device is not connected.',
        severity: 'error',
        commonCauses: [
            'USB device removed',
            'Network connection lost',
            'Hardware failure'
        ]
    },

    // Exception Codes
    0xC0000094: {
        code: 0xC0000094,
        name: 'STATUS_INTEGER_DIVIDE_BY_ZERO',
        description: 'An integer divide by zero was attempted.',
        severity: 'error',
        commonCauses: [
            'Division by zero in driver code',
            'Invalid data causing zero divisor',
            'Missing validation'
        ],
        suggestedFix: 'Add divisor validation before performing division.'
    },
    0xC0000095: {
        code: 0xC0000095,
        name: 'STATUS_INTEGER_OVERFLOW',
        description: 'An integer overflow occurred.',
        severity: 'error',
        commonCauses: [
            'Arithmetic overflow',
            'Type conversion error',
            'Buffer size calculation error'
        ]
    },
    0xC0000096: {
        code: 0xC0000096,
        name: 'STATUS_PRIVILEGED_INSTRUCTION',
        description: 'An attempt was made to execute a privileged instruction.',
        severity: 'error',
        commonCauses: [
            'User-mode code executing kernel instruction',
            'Incorrect CPU ring level',
            'Malware attempt'
        ]
    },
    0xC000001D: {
        code: 0xC000001D,
        name: 'STATUS_ILLEGAL_INSTRUCTION',
        description: 'An attempt was made to execute an illegal instruction.',
        severity: 'error',
        commonCauses: [
            'Corrupted code',
            'Jumping to data',
            'CPU feature not supported',
            'Binary incompatibility'
        ],
        suggestedFix: 'Check for code corruption or incorrect CPU targeting.'
    },
    0xC00002B5: {
        code: 0xC00002B5,
        name: 'STATUS_FLOAT_MULTIPLE_FAULTS',
        description: 'Multiple floating point faults.',
        severity: 'error',
        commonCauses: [
            'FPU state corruption',
            'Invalid floating point operations',
            'Hardware FPU issues'
        ]
    },
    0xC00002B4: {
        code: 0xC00002B4,
        name: 'STATUS_FLOAT_MULTIPLE_TRAPS',
        description: 'Multiple floating point traps.',
        severity: 'error'
    },

    // File System Errors
    0xC0000022: {
        code: 0xC0000022,
        name: 'STATUS_ACCESS_DENIED',
        description: 'A process has requested access to an object but has not been granted those access rights.',
        severity: 'error',
        commonCauses: [
            'Insufficient permissions',
            'File locked by another process',
            'Security descriptor blocking access'
        ]
    },
    0xC0000034: {
        code: 0xC0000034,
        name: 'STATUS_OBJECT_NAME_NOT_FOUND',
        description: 'The object name is not found.',
        severity: 'error',
        commonCauses: [
            'File or registry key not found',
            'Path error',
            'Object deleted'
        ]
    },
    0xC0000043: {
        code: 0xC0000043,
        name: 'STATUS_SHARING_VIOLATION',
        description: 'A file cannot be opened because the share access flags are incompatible.',
        severity: 'error',
        commonCauses: [
            'File locked by another process',
            'Exclusive access conflict',
            'Antivirus scanning'
        ]
    },
    0xC0000056: {
        code: 0xC0000056,
        name: 'STATUS_DELETE_PENDING',
        description: 'A file cannot be opened because the file has been marked for deletion.',
        severity: 'error'
    },
    0xC0000098: {
        code: 0xC0000098,
        name: 'STATUS_FILE_INVALID',
        description: 'The volume does not contain a recognized file system.',
        severity: 'error',
        commonCauses: [
            'Corrupted file system',
            'Unformatted drive',
            'Boot sector damage'
        ]
    },

    // Driver and Device Errors
    0xC0000001: {
        code: 0xC0000001,
        name: 'STATUS_UNSUCCESSFUL',
        description: 'The requested operation was unsuccessful.',
        severity: 'error',
        commonCauses: [
            'Generic driver failure',
            'Operation cannot be completed',
            'Device error'
        ]
    },
    0xC0000002: {
        code: 0xC0000002,
        name: 'STATUS_NOT_IMPLEMENTED',
        description: 'The requested operation is not implemented.',
        severity: 'error',
        commonCauses: [
            'Feature not supported',
            'Missing driver functionality',
            'Stub function called'
        ]
    },
    0xC00000BB: {
        code: 0xC00000BB,
        name: 'STATUS_NOT_SUPPORTED',
        description: 'The request is not supported.',
        severity: 'error',
        commonCauses: [
            'Hardware limitation',
            'Driver capability missing',
            'Protocol version mismatch'
        ]
    },
    0xC00000A3: {
        code: 0xC00000A3,
        name: 'STATUS_DEVICE_NOT_READY',
        description: 'The device is not ready.',
        severity: 'error',
        commonCauses: [
            'Device initializing',
            'Power state transition',
            'Hardware not responding'
        ]
    },
    0xC00000AE: {
        code: 0xC00000AE,
        name: 'STATUS_DEVICE_POWER_FAILURE',
        description: 'There is not enough power to complete the requested operation.',
        severity: 'error',
        commonCauses: [
            'Power supply issue',
            'USB power exceeded',
            'Battery depleted'
        ]
    },

    // Critical Process and System Errors
    0xC000021A: {
        code: 0xC000021A,
        name: 'STATUS_SYSTEM_PROCESS_TERMINATED',
        description: 'A critical system process died.',
        severity: 'error',
        commonCauses: [
            'CSRSS.exe crash',
            'Winlogon.exe crash',
            'System file corruption',
            'Malware activity'
        ],
        suggestedFix: 'Boot from recovery media and run sfc /scannow offline.'
    },
    0xC0000218: {
        code: 0xC0000218,
        name: 'STATUS_CANNOT_LOAD_REGISTRY_FILE',
        description: 'A registry file cannot be loaded.',
        severity: 'error',
        commonCauses: [
            'Registry hive corruption',
            'Disk error',
            'Failed Windows update'
        ],
        suggestedFix: 'Restore registry from backup or use System Restore.'
    },
    0xC0000221: {
        code: 0xC0000221,
        name: 'STATUS_IMAGE_CHECKSUM_MISMATCH',
        description: 'The image file is corrupted. The header checksum does not match the computed checksum.',
        severity: 'error',
        commonCauses: [
            'Corrupted driver file',
            'Disk error during file read',
            'Incomplete update',
            'Malware modification'
        ],
        suggestedFix: 'Run sfc /scannow to repair system files.'
    },

    // Hardware and WHEA Errors
    0xC0000374: {
        code: 0xC0000374,
        name: 'STATUS_HEAP_CORRUPTION',
        description: 'A heap has been corrupted.',
        severity: 'error',
        commonCauses: [
            'Buffer overflow',
            'Use-after-free',
            'Double free',
            'Driver memory corruption'
        ],
        suggestedFix: 'Enable heap verification and driver verifier to find the source.'
    },
    0xC000035A: {
        code: 0xC000035A,
        name: 'STATUS_HARDWARE_CORRUPTION_DETECTED',
        description: 'Hardware corruption detected.',
        severity: 'error',
        commonCauses: [
            'CPU error',
            'Memory hardware failure',
            'Motherboard issue',
            'Power supply instability'
        ],
        suggestedFix: 'Run hardware diagnostics, check temperatures, and test memory.'
    },

    // Timeout and Synchronization Errors
    0xC00000B5: {
        code: 0xC00000B5,
        name: 'STATUS_IO_TIMEOUT',
        description: 'The I/O operation was not completed before the time-out period expired.',
        severity: 'error',
        commonCauses: [
            'Slow storage device',
            'Device not responding',
            'Cable or connection issue',
            'Driver hang'
        ]
    },
    0xC000010A: {
        code: 0xC000010A,
        name: 'STATUS_PROCESS_IS_TERMINATING',
        description: 'An attempt to access an exiting process or thread was made.',
        severity: 'error'
    },
    0xC0000192: {
        code: 0xC0000192,
        name: 'STATUS_COMMITMENT_LIMIT',
        description: 'The system commit limit has been exceeded.',
        severity: 'error',
        commonCauses: [
            'Virtual memory exhausted',
            'Page file full',
            'Memory leak'
        ],
        suggestedFix: 'Increase page file size or add more RAM.'
    },

    // Security Errors
    0xC0000409: {
        code: 0xC0000409,
        name: 'STATUS_STACK_BUFFER_OVERRUN',
        description: 'A stack buffer overrun was detected.',
        severity: 'error',
        commonCauses: [
            'Buffer overflow exploit',
            'Driver bug',
            'Security cookie corrupted',
            'Malware activity'
        ],
        suggestedFix: 'Check for security vulnerabilities and scan for malware.'
    },
    0xC0000420: {
        code: 0xC0000420,
        name: 'STATUS_ASSERTION_FAILURE',
        description: 'An assertion failure was encountered.',
        severity: 'error',
        commonCauses: [
            'Internal consistency check failed',
            'Debug assertion in production code',
            'Data structure corruption'
        ]
    },
    0xC0000428: {
        code: 0xC0000428,
        name: 'STATUS_INVALID_IMAGE_HASH',
        description: 'Windows cannot verify the digital signature for this file.',
        severity: 'error',
        commonCauses: [
            'Unsigned driver',
            'Corrupted binary',
            'Modified system file',
            'Secure Boot violation'
        ]
    },

    // Initialization Errors
    0xC0000142: {
        code: 0xC0000142,
        name: 'STATUS_DLL_INIT_FAILED',
        description: 'DLL initialization failed.',
        severity: 'error',
        commonCauses: [
            'Missing dependency',
            'DllMain returned FALSE',
            'Initialization order issue'
        ]
    },
    0xC0000135: {
        code: 0xC0000135,
        name: 'STATUS_DLL_NOT_FOUND',
        description: 'A required DLL was not found.',
        severity: 'error',
        commonCauses: [
            'Missing DLL file',
            'Incorrect PATH',
            'Architecture mismatch (32/64-bit)'
        ]
    },

    // Disk and Storage Errors
    0xC000009C: {
        code: 0xC000009C,
        name: 'STATUS_DEVICE_DATA_ERROR',
        description: 'A parity error was detected on the device.',
        severity: 'error',
        commonCauses: [
            'Disk read error',
            'Bad sectors',
            'Cable issue',
            'Hardware failure'
        ],
        suggestedFix: 'Check disk health with SMART tools and run chkdsk.'
    },
    0xC0000185: {
        code: 0xC0000185,
        name: 'STATUS_IO_DEVICE_ERROR',
        description: 'An I/O operation failed due to a device error.',
        severity: 'error',
        commonCauses: [
            'Device hardware failure',
            'Bad connection',
            'Driver error'
        ]
    },
    0xC0000012: {
        code: 0xC0000012,
        name: 'STATUS_MEDIA_WRITE_PROTECTED',
        description: 'The media is write protected.',
        severity: 'error',
        commonCauses: [
            'USB drive write protection',
            'SD card lock switch',
            'Read-only share'
        ]
    }
};

/**
 * Lookup an NTSTATUS code
 */
export function lookupNtStatus(code: number): NtStatusInfo | undefined {
    // Handle both positive and negative representations
    const normalizedCode = code >>> 0; // Convert to unsigned
    return NTSTATUS_CODES[normalizedCode];
}

/**
 * Get NTSTATUS severity from code
 */
export function getNtStatusSeverity(code: number): 'success' | 'informational' | 'warning' | 'error' {
    const normalizedCode = code >>> 0;
    const severity = (normalizedCode >>> 30) & 0x3;
    switch (severity) {
        case 0: return 'success';
        case 1: return 'informational';
        case 2: return 'warning';
        case 3: return 'error';
        default: return 'error';
    }
}

/**
 * Get human-readable description of NTSTATUS code
 */
export function describeNtStatus(code: number): string {
    const info = lookupNtStatus(code);
    if (info) {
        let description = `${info.name}: ${info.description}`;
        if (info.commonCauses && info.commonCauses.length > 0) {
            description += `\nCommon causes: ${info.commonCauses.join(', ')}`;
        }
        if (info.suggestedFix) {
            description += `\nSuggested fix: ${info.suggestedFix}`;
        }
        return description;
    }

    // Return generic description based on severity
    const severity = getNtStatusSeverity(code);
    const hexCode = `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
    return `Unknown NTSTATUS ${hexCode} (Severity: ${severity})`;
}

/**
 * Check if an NTSTATUS indicates an error
 */
export function isNtStatusError(code: number): boolean {
    return getNtStatusSeverity(code) === 'error';
}

/**
 * Decode exception code from bug check parameters
 */
export function decodeExceptionCode(code: number | bigint): string {
    const numCode = typeof code === 'bigint' ? Number(code & 0xFFFFFFFFn) : code;
    const info = lookupNtStatus(numCode);

    if (info) {
        return `${info.name} (0x${(numCode >>> 0).toString(16).toUpperCase()}): ${info.description}`;
    }

    // Check for common exception patterns
    const upperNibble = (numCode >>> 28) & 0xF;
    if (upperNibble === 0xC) {
        return `NTSTATUS Error 0x${numCode.toString(16).toUpperCase()}: Unknown Windows error code`;
    }

    return `Unknown exception code 0x${numCode.toString(16).toUpperCase()}`;
}

/**
 * Get recommended actions for an NTSTATUS error
 */
export function getNtStatusRecommendations(code: number): string[] {
    const info = lookupNtStatus(code);
    const recommendations: string[] = [];

    if (info) {
        if (info.suggestedFix) {
            recommendations.push(info.suggestedFix);
        }

        // Add common causes as investigation points
        if (info.commonCauses) {
            recommendations.push(`Investigate these potential causes: ${info.commonCauses.join(', ')}`);
        }
    }

    // Generic recommendations based on error type
    const hexCode = (code >>> 0).toString(16).toUpperCase();
    switch (code >>> 0) {
        case 0xC0000005:
            recommendations.push('Enable Driver Verifier to catch access violations');
            recommendations.push('Check for recently updated drivers');
            break;
        case 0xC00000FD:
            recommendations.push('Review code for deep recursion patterns');
            recommendations.push('Consider increasing stack size if legitimate');
            break;
        case 0xC0000017:
        case 0xC000009A:
            recommendations.push('Check for memory leaks using poolmon');
            recommendations.push('Increase page file size');
            break;
    }

    if (recommendations.length === 0) {
        recommendations.push(`Research NTSTATUS 0x${hexCode} for specific guidance`);
    }

    return recommendations;
}
