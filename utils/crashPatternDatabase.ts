// Comprehensive crash pattern database for accurate BSOD analysis
// Based on Microsoft documentation and real-world crash dump analysis

export interface CrashPattern {
    bugCheckCode: number;
    name: string;
    parameters: {
        param1: { name: string; description: string };
        param2: { name: string; description: string };
        param3: { name: string; description: string };
        param4: { name: string; description: string };
    };
    commonCauses: string[];
    diagnosticSteps: string[];
    immediateActions: string[];
    memoryPatterns?: {
        pattern: string;
        meaning: string;
    }[];
    relatedDrivers?: string[];
    kernelStructures?: string[];
}

export const CRASH_PATTERN_DATABASE: Record<number, CrashPattern> = {
    0x0000000A: {
        bugCheckCode: 0x0000000A,
        name: 'IRQL_NOT_LESS_OR_EQUAL',
        parameters: {
            param1: { name: 'Memory Referenced', description: 'Virtual address that could not be accessed' },
            param2: { name: 'IRQL', description: 'IRQL at time of reference' },
            param3: { name: 'Access Type', description: '0=Read, 1=Write, 8=Execute' },
            param4: { name: 'Instruction Address', description: 'Address that referenced the bad memory' }
        },
        commonCauses: [
            'Driver accessing paged memory at DISPATCH_LEVEL or above',
            'Corrupt system service descriptor table',
            'Driver using incorrect memory access functions',
            'Hardware memory corruption',
            'Improper synchronization in driver code'
        ],
        diagnosticSteps: [
            'Check if Param4 points to a third-party driver',
            'Verify IRQL level (Param2) - if 2 or higher, paged memory access is invalid',
            'Look for recently installed drivers or hardware',
            'Check for patterns indicating double-free or use-after-free'
        ],
        immediateActions: [
            'Use Driver Verifier with Special Pool enabled',
            'Update or remove the driver at Param4 address',
            'Test memory with Windows Memory Diagnostic',
            'Check for BIOS/firmware updates'
        ],
        memoryPatterns: [
            { pattern: '0xDEADBEEF', meaning: 'Use-after-free marker' },
            { pattern: '0xBAD0B0B0', meaning: 'Bad pool block' }
        ],
        relatedDrivers: ['ndis.sys', 'tcpip.sys', 'netio.sys']
    },

    0x0000001E: {
        bugCheckCode: 0x0000001E,
        name: 'KMODE_EXCEPTION_NOT_HANDLED',
        parameters: {
            param1: { name: 'Exception Code', description: 'The exception code that was not handled (e.g., 0xC0000005 for access violation)' },
            param2: { name: 'Exception Address', description: 'The address where the exception occurred' },
            param3: { name: 'Exception Parameter 0', description: 'First parameter of the exception (usually 0 for read, 1 for write)' },
            param4: { name: 'Exception Parameter 1', description: 'Second parameter of the exception (usually the address being accessed)' }
        },
        commonCauses: [
            'Driver attempting to access invalid memory',
            'Corrupt driver code or data structures',
            'Stack overflow in kernel mode',
            'Hardware memory errors',
            'Incompatible or outdated drivers',
            'Incorrect exception handling in driver code'
        ],
        diagnosticSteps: [
            'Identify the driver from exception address (Param2)',
            'Check exception code (Param1) - 0xC0000005 = access violation, 0xC0000094 = divide by zero',
            'If Param3 is 0, it was a read operation; if 1, write operation',
            'Look for recently installed or updated drivers',
            'Check if address in Param4 is valid kernel memory'
        ],
        immediateActions: [
            'Update or rollback the driver containing the exception address',
            'Run memory diagnostic to rule out hardware issues',
            'Boot in Safe Mode to isolate driver issues',
            'Use Driver Verifier on suspected drivers',
            'Check Event Viewer for related errors before the crash'
        ],
        memoryPatterns: [
            { pattern: '0xC0000005', meaning: 'Access violation - invalid memory access' },
            { pattern: '0xC0000094', meaning: 'Integer divide by zero' },
            { pattern: '0xC000001D', meaning: 'Illegal instruction' },
            { pattern: '0xC0000096', meaning: 'Privileged instruction' }
        ],
        relatedDrivers: ['win32k.sys', 'nvlddmkm.sys', 'atikmdag.sys', 'igdkmd64.sys']
    },

    0x00000050: {
        bugCheckCode: 0x00000050,
        name: 'PAGE_FAULT_IN_NONPAGED_AREA',
        parameters: {
            param1: { name: 'Memory Referenced', description: 'Virtual address that caused the fault' },
            param2: { name: 'Access Type', description: '0=Read, 1=Write, 2=Execute, 10=Execute (DEP)' },
            param3: { name: 'Faulting Address', description: 'Address of instruction that caused fault' },
            param4: { name: 'Reserved', description: 'Reserved for future use' }
        },
        commonCauses: [
            'Faulty RAM or other hardware issues',
            'Incompatible or corrupt drivers',
            'Damaged hard disk or file system',
            'Antivirus software conflicts',
            'Incorrect memory configuration in BIOS'
        ],
        diagnosticSteps: [
            'Check if address is NULL or near-NULL (indicates NULL pointer dereference)',
            'Verify if fault address is in driver or kernel space',
            'Look for patterns of corruption in surrounding memory',
            'Check page table entries for the faulting address'
        ],
        immediateActions: [
            'Run chkdsk /f /r to check file system',
            'Test RAM with MemTest86+ for extended period',
            'Boot in Safe Mode to isolate driver issues',
            'Disable recently installed software/drivers'
        ],
        memoryPatterns: [
            { pattern: '0x00000000', meaning: 'NULL pointer dereference' },
            { pattern: '0xFFFFFFFF', meaning: 'Invalid/corrupted pointer' }
        ]
    },

    0x0000007E: {
        bugCheckCode: 0x0000007E,
        name: 'SYSTEM_THREAD_EXCEPTION_NOT_HANDLED',
        parameters: {
            param1: { name: 'Exception Code', description: 'The exception code that was not handled' },
            param2: { name: 'Exception Address', description: 'Address where exception occurred' },
            param3: { name: 'Exception Record', description: 'Pointer to exception record' },
            param4: { name: 'Context Record', description: 'Pointer to context record' }
        },
        commonCauses: [
            'Driver bugs causing unhandled exceptions',
            'Memory corruption in kernel space',
            'Stack overflow in kernel mode',
            'Hardware compatibility issues',
            'Damaged system files'
        ],
        diagnosticSteps: [
            'Decode exception code (Param1) - check if ACCESS_VIOLATION, STACK_OVERFLOW, etc.',
            'Identify module containing exception address',
            'Analyze context record for register state',
            'Check for recursive exceptions'
        ],
        immediateActions: [
            'Update driver containing exception address',
            'Run sfc /scannow to check system files',
            'Check for stack overflow patterns',
            'Disable problematic drivers in Safe Mode'
        ],
        kernelStructures: ['EXCEPTION_RECORD', 'CONTEXT', 'KTHREAD']
    },

    0x00000124: {
        bugCheckCode: 0x00000124,
        name: 'WHEA_UNCORRECTABLE_ERROR',
        parameters: {
            param1: { name: 'MCE Bank Number', description: 'Machine Check Exception bank or error source' },
            param2: { name: 'Error Record Address', description: 'Address of WHEA_ERROR_RECORD structure' },
            param3: { name: 'MCi_STATUS High', description: 'High 32 bits of MCi_STATUS MSR' },
            param4: { name: 'MCi_STATUS Low', description: 'Low 32 bits of MCi_STATUS MSR' }
        },
        commonCauses: [
            'CPU hardware errors or overheating',
            'Faulty CPU, motherboard, or power supply',
            'Overclocking instability',
            'Incompatible or failing RAM',
            'BIOS/UEFI bugs or misconfigurations'
        ],
        diagnosticSteps: [
            'Decode MCi_STATUS value for specific error type',
            'Check CPU temperature and thermal throttling',
            'Review system event log for WHEA-Logger entries',
            'Verify CPU microcode version'
        ],
        immediateActions: [
            'Reset BIOS/UEFI to default settings',
            'Disable all overclocking',
            'Check CPU cooling and thermal paste',
            'Update BIOS/UEFI and CPU microcode',
            'Test with minimal hardware configuration'
        ],
        memoryPatterns: [
            { pattern: 'MCA Error', meaning: 'Machine Check Architecture error detected' }
        ]
    },

    0x00000139: {
        bugCheckCode: 0x00000139,
        name: 'KERNEL_SECURITY_CHECK_FAILURE',
        parameters: {
            param1: { name: 'Security Check Type', description: 'Type of corruption detected' },
            param2: { name: 'Failure Address', description: 'Address of corruption or security check' },
            param3: { name: 'Expected Value', description: 'Expected security cookie or value' },
            param4: { name: 'Context', description: 'Additional context information' }
        },
        commonCauses: [
            'Stack buffer overflow detected',
            'Security cookie corruption',
            'Kernel data structure corruption',
            'Exploit attempt or malware',
            'Driver bugs corrupting security structures'
        ],
        diagnosticSteps: [
            'Identify security check type from Param1',
            'Check for buffer overflow patterns',
            'Analyze corrupted data structure',
            'Look for ROP gadgets or exploit indicators'
        ],
        immediateActions: [
            'Scan system for malware',
            'Enable Driver Verifier for all drivers',
            'Update all drivers and Windows',
            'Check for rootkits with specialized tools',
            'Review security event logs'
        ],
        memoryPatterns: [
            { pattern: 'Stack cookies', meaning: 'Security mitigation detected corruption' }
        ]
    },

    0x000000D1: {
        bugCheckCode: 0x000000D1,
        name: 'DRIVER_IRQL_NOT_LESS_OR_EQUAL',
        parameters: {
            param1: { name: 'Memory Referenced', description: 'Address driver attempted to access' },
            param2: { name: 'IRQL', description: 'IRQL at time of violation' },
            param3: { name: 'Access Type', description: '0=Read, 1=Write, 8=Execute' },
            param4: { name: 'Driver Address', description: 'Address in driver that caused error' }
        },
        commonCauses: [
            'Network driver bugs (especially WiFi/Ethernet)',
            'USB driver issues',
            'Antivirus filter drivers',
            'Storage driver problems',
            'Incorrect spinlock usage'
        ],
        diagnosticSteps: [
            'Identify driver from Param4 address',
            'Check if driver is third-party',
            'Verify proper IRQL for operation',
            'Look for spinlock held too long'
        ],
        immediateActions: [
            'Update identified driver immediately',
            'Disable driver if possible',
            'Check manufacturer website for updates',
            'Use Driver Verifier on suspected driver'
        ],
        relatedDrivers: ['e1i63x64.sys', 'Netwtw04.sys', 'athw8x.sys', 'nvlddmkm.sys']
    },

    0x00000133: {
        bugCheckCode: 0x00000133,
        name: 'DPC_WATCHDOG_VIOLATION',
        parameters: {
            param1: { name: 'DPC Time Count', description: '0=Single DPC exceeded limit, 1=System cumulative limit' },
            param2: { name: 'Time Limit', description: 'DPC time limit in ticks' },
            param3: { name: 'Cast to nt!DPC_WATCHDOG_GLOBAL_TRIAGE_BLOCK', description: 'Pointer to triage block' },
            param4: { name: 'Reserved', description: 'Reserved' }
        },
        commonCauses: [
            'Storage driver latency (SSD firmware bugs)',
            'Graphics driver DPC routines',
            'Network driver processing delays',
            'Power management conflicts',
            'IDE/AHCI/RAID mode misconfigurations'
        ],
        diagnosticSteps: [
            'Check if Param1 is 0 (single DPC) or 1 (cumulative)',
            'Identify long-running DPC from triage block',
            'Review storage controller configuration',
            'Check for firmware updates'
        ],
        immediateActions: [
            'Update SSD/HDD firmware',
            'Change SATA mode in BIOS',
            'Update storage controller drivers',
            'Disable power management for storage',
            'Check for driver updates'
        ],
        relatedDrivers: ['storahci.sys', 'stornvme.sys', 'iaStorA.sys', 'amdxata.sys']
    },

    0x000000C2: {
        bugCheckCode: 0x000000C2,
        name: 'BAD_POOL_CALLER',
        parameters: {
            param1: { name: 'Pool Violation Type', description: 'Type of pool corruption detected' },
            param2: { name: 'Pool Header/Size', description: 'Pool header address or allocation size' },
            param3: { name: 'Pool Header Contents', description: 'First part of pool header' },
            param4: { name: 'Reserved', description: 'Reserved' }
        },
        commonCauses: [
            'Driver allocating/freeing pool incorrectly',
            'Double-free of pool memory',
            'Buffer overflow in pool allocation',
            'Accessing freed pool memory',
            'Pool tag corruption'
        ],
        diagnosticSteps: [
            'Decode pool violation type from Param1',
            'Examine pool header for corruption patterns',
            'Identify pool tag and owning driver',
            'Check for double-free patterns (0xDEADBEEF)'
        ],
        immediateActions: [
            'Enable Driver Verifier with pool tracking',
            'Identify driver from pool tag',
            'Update or remove problematic driver',
            'Check for pattern of pool corruptions'
        ],
        memoryPatterns: [
            { pattern: '0xDEADBEEF', meaning: 'Freed pool marker' },
            { pattern: '0xBAD0B0B0', meaning: 'Bad pool header' },
            { pattern: '0xFEEEFEEE', meaning: 'Freed pool content' }
        ]
    },

    0x000000F5: {
        bugCheckCode: 0x000000F5,
        name: 'FLTMGR_FILE_SYSTEM',
        parameters: {
            param1: { name: 'Error Type', description: 'Type of filter manager error' },
            param2: { name: 'Object Address', description: 'Address of the object (context, filter, etc.)' },
            param3: { name: 'Additional Info', description: 'Additional information about the error' },
            param4: { name: 'Reserved', description: 'Reserved for future use' }
        },
        commonCauses: [
            'Filter driver released context structure multiple times',
            'Context structure referenced after being freed',
            'Filter driver corruption in file system filter manager',
            'Antivirus or backup software filter driver bugs',
            'Incompatible filter drivers'
        ],
        diagnosticSteps: [
            'Check Parameter 1 for specific error type (0x6E = context freed)',
            'Identify filter driver from stack trace',
            'Look for antivirus/backup software involvement',
            'Check for filter driver updates'
        ],
        immediateActions: [
            'Update or uninstall problematic filter drivers',
            'Temporarily disable antivirus real-time scanning',
            'Check for Windows updates',
            'Run fltmc.exe to list filter drivers',
            'Use Driver Verifier on filter drivers'
        ],
        relatedDrivers: ['fltmgr.sys', 'bindflt.sys', 'wcifs.sys', 'cldflt.sys']
    },

    0x000001E0: {
        bugCheckCode: 0x000001E0,
        name: 'INVALID_KERNEL_HANDLE',
        parameters: {
            param1: { name: 'Handle Value', description: 'The invalid handle value' },
            param2: { name: 'Handle Table Entry', description: 'Pointer to handle table entry' },
            param3: { name: 'Object Type', description: 'Expected object type' },
            param4: { name: 'Calling Address', description: 'Address that used invalid handle' }
        },
        commonCauses: [
            'Driver using closed or invalid handle',
            'Handle table corruption',
            'Race condition in handle usage',
            'Double-close of handle',
            'Cross-process handle usage error'
        ],
        diagnosticSteps: [
            'Identify caller from Param4',
            'Check if handle was previously valid',
            'Look for patterns of handle misuse',
            'Verify object type expectations'
        ],
        immediateActions: [
            'Enable handle tracing in Driver Verifier',
            'Update driver at calling address',
            'Check for race conditions in driver',
            'Review handle lifecycle in driver code'
        ],
        kernelStructures: ['HANDLE_TABLE', 'HANDLE_TABLE_ENTRY', 'OBJECT_HEADER']
    },

    // Most frequent additional errors
    0x0000001A: {
        bugCheckCode: 0x0000001A,
        name: 'MEMORY_MANAGEMENT',
        parameters: {
            param1: { name: 'Error Type', description: 'Type of memory error detected' },
            param2: { name: 'Address', description: 'Address where error occurred' },
            param3: { name: 'Parameter', description: 'Depends on error type' },
            param4: { name: 'Reserved', description: 'Reserved for future use' }
        },
        commonCauses: [
            'Faulty RAM modules',
            'Driver memory corruption',
            'Software bugs in kernel code',
            'Disk errors affecting page file',
            'Hardware memory controller issues'
        ],
        diagnosticSteps: [
            'Run Windows Memory Diagnostic',
            'Check for recently installed drivers',
            'Verify page file configuration',
            'Look for patterns in crash addresses'
        ],
        immediateActions: [
            'Test RAM with MemTest86+',
            'Update all drivers',
            'Check disk for errors',
            'Disable memory overclocking',
            'Run sfc /scannow'
        ],
        memoryPatterns: [
            { pattern: '0x41790', meaning: 'Page table corruption' },
            { pattern: '0x41784', meaning: 'Working set corruption' }
        ]
    },

    // Hardware-related errors
    0x0000009C: {
        bugCheckCode: 0x0000009C,
        name: 'MACHINE_CHECK_EXCEPTION',
        parameters: {
            param1: { name: 'Bank Number', description: 'Machine Check Exception bank number' },
            param2: { name: 'Address', description: 'Address of MCE descriptor' },
            param3: { name: 'High order 32-bits of MCi_STATUS', description: 'MCE status high' },
            param4: { name: 'Low order 32-bits of MCi_STATUS', description: 'MCE status low' }
        },
        commonCauses: [
            'CPU hardware failure',
            'Motherboard component failure',
            'Power supply instability',
            'Overheating causing hardware errors',
            'Failing memory controller'
        ],
        diagnosticSteps: [
            'Check CPU temperature immediately',
            'Review MCE bank logs',
            'Verify power supply voltages',
            'Check for BIOS/microcode updates'
        ],
        immediateActions: [
            'Stop any overclocking immediately',
            'Check and replace thermal paste',
            'Test with different power supply',
            'Update BIOS and CPU microcode',
            'Run CPU stress tests carefully'
        ]
    },

    0x00000101: {
        bugCheckCode: 0x00000101,
        name: 'CLOCK_WATCHDOG_TIMEOUT',
        parameters: {
            param1: { name: 'Clock Interrupt Period', description: 'Expected clock interrupt period' },
            param2: { name: 'Nominal Period', description: 'Measured clock interrupt period' },
            param3: { name: 'Reserved', description: 'Reserved' },
            param4: { name: 'Processor Number', description: 'Processor that timed out' }
        },
        commonCauses: [
            'Multi-processor synchronization failure',
            'CPU core not responding',
            'BIOS/UEFI bugs with multi-core CPUs',
            'Overclocking instability',
            'Hardware timing issues'
        ],
        diagnosticSteps: [
            'Check which processor core failed',
            'Verify CPU temperatures',
            'Check for BIOS updates',
            'Review overclocking settings'
        ],
        immediateActions: [
            'Disable CPU overclocking',
            'Update BIOS/UEFI',
            'Disable Hyper-Threading temporarily',
            'Check CPU cooling',
            'Test with single core'
        ]
    },

    0x0000005C: {
        bugCheckCode: 0x0000005C,
        name: 'HAL_INITIALIZATION_FAILED',
        parameters: {
            param1: { name: 'HAL Filename', description: 'Name of HAL file' },
            param2: { name: 'Reserved', description: 'Reserved' },
            param3: { name: 'Reserved', description: 'Reserved' },
            param4: { name: 'Reserved', description: 'Reserved' }
        },
        commonCauses: [
            'Hardware incompatibility',
            'Wrong HAL type for hardware',
            'BIOS configuration issues',
            'Boot configuration corruption',
            'Hardware changes not recognized'
        ],
        diagnosticSteps: [
            'Check recent hardware changes',
            'Verify BIOS settings',
            'Check boot configuration',
            'Review system logs'
        ],
        immediateActions: [
            'Reset BIOS to defaults',
            'Remove recently added hardware',
            'Repair Windows boot files',
            'Check hardware compatibility',
            'Update BIOS firmware'
        ]
    },

    // File System Errors
    0x00000023: {
        bugCheckCode: 0x00000023,
        name: 'FAT_FILE_SYSTEM',
        parameters: {
            param1: { name: 'Error Object', description: 'Object that caused the error' },
            param2: { name: 'Device Object', description: 'Device object for the file system' },
            param3: { name: 'Reserved', description: 'Reserved' },
            param4: { name: 'Reserved', description: 'Reserved' }
        },
        commonCauses: [
            'FAT file system corruption',
            'Failing hard drive',
            'Improper shutdown during write',
            'USB drive issues',
            'Memory corruption affecting file system'
        ],
        diagnosticSteps: [
            'Identify which FAT drive failed',
            'Check disk health with SMART tools',
            'Look for USB device issues',
            'Check file system integrity'
        ],
        immediateActions: [
            'Run chkdsk on affected drive',
            'Backup data immediately',
            'Test drive with manufacturer tools',
            'Check USB connections',
            'Scan for malware'
        ]
    },

    0x00000024: {
        bugCheckCode: 0x00000024,
        name: 'NTFS_FILE_SYSTEM',
        parameters: {
            param1: { name: 'Error Code', description: 'NTFS error code' },
            param2: { name: 'Address', description: 'Address of the exception record' },
            param3: { name: 'Address', description: 'Address of the context record' },
            param4: { name: 'Reserved', description: 'Reserved' }
        },
        commonCauses: [
            'NTFS file system corruption',
            'Bad sectors on hard drive',
            'Failing storage device',
            'Memory errors corrupting file cache',
            'Antivirus software conflicts'
        ],
        diagnosticSteps: [
            'Check NTFS error code in Param1',
            'Review disk SMART data',
            'Check for file system corruption',
            'Verify disk cables and connections'
        ],
        immediateActions: [
            'Run chkdsk /f /r',
            'Backup critical data',
            'Check disk health with CrystalDiskInfo',
            'Temporarily disable antivirus',
            'Update storage drivers'
        ]
    },

    0x0000002E: {
        bugCheckCode: 0x0000002E,
        name: 'DATA_BUS_ERROR',
        parameters: {
            param1: { name: 'Virtual Address', description: 'Virtual address that caused the error' },
            param2: { name: 'Physical Address', description: 'Physical address that caused the error' },
            param3: { name: 'Processor Status Register', description: 'PSR contents' },
            param4: { name: 'Faulting Instruction Register', description: 'FIR contents' }
        },
        commonCauses: [
            'RAM parity error',
            'Motherboard failure',
            'CPU cache corruption',
            'Power supply issues',
            'Electromagnetic interference'
        ],
        diagnosticSteps: [
            'Test RAM modules individually',
            'Check motherboard for physical damage',
            'Verify power supply stability',
            'Look for sources of interference'
        ],
        immediateActions: [
            'Run extensive memory tests',
            'Check all cable connections',
            'Test with minimal hardware',
            'Replace RAM if errors persist',
            'Check motherboard capacitors'
        ]
    },

    0x0000007A: {
        bugCheckCode: 0x0000007A,
        name: 'KERNEL_DATA_INPAGE_ERROR',
        parameters: {
            param1: { name: 'Lock Type', description: 'Type of lock' },
            param2: { name: 'Error Status', description: 'I/O error status code' },
            param3: { name: 'Current Process', description: 'Current process address' },
            param4: { name: 'Memory Address', description: 'Address kernel couldn\'t read' }
        },
        commonCauses: [
            'Bad blocks on hard drive',
            'Loose or faulty SATA/IDE cables',
            'Memory corruption',
            'Virus or malware infection',
            'Page file corruption'
        ],
        diagnosticSteps: [
            'Check error status code in Param2',
            'Identify if disk or memory related',
            'Check disk for bad sectors',
            'Verify cable connections'
        ],
        immediateActions: [
            'Run disk check utility',
            'Check and reseat disk cables',
            'Test RAM for errors',
            'Scan for malware',
            'Check page file location'
        ]
    },

    // Security and System Errors
    0x00000029: {
        bugCheckCode: 0x00000029,
        name: 'SECURITY_SYSTEM',
        parameters: {
            param1: { name: 'Security Error Type', description: 'Type of security failure' },
            param2: { name: 'Parameter 1', description: 'Depends on error type' },
            param3: { name: 'Parameter 2', description: 'Depends on error type' },
            param4: { name: 'Parameter 3', description: 'Depends on error type' }
        },
        commonCauses: [
            'Security subsystem initialization failure',
            'Security software conflicts',
            'Corrupted security descriptors',
            'Malware attempting to bypass security',
            'System file corruption'
        ],
        diagnosticSteps: [
            'Check security event logs',
            'Review recently installed security software',
            'Look for signs of malware',
            'Verify system file integrity'
        ],
        immediateActions: [
            'Boot in Safe Mode',
            'Remove conflicting security software',
            'Run comprehensive malware scan',
            'Run sfc /scannow',
            'Check for rootkits'
        ]
    },

    0x0000009A: {
        bugCheckCode: 0x0000009A,
        name: 'SYSTEM_LICENSE_VIOLATION',
        parameters: {
            param1: { name: 'Violation Type', description: 'Type of license violation' },
            param2: { name: 'Reserved', description: 'Reserved' },
            param3: { name: 'Reserved', description: 'Reserved' },
            param4: { name: 'Reserved', description: 'Reserved' }
        },
        commonCauses: [
            'Windows activation issues',
            'License agreement violation',
            'System file tampering',
            'Hardware changes triggering reactivation',
            'Corrupted license files'
        ],
        diagnosticSteps: [
            'Check Windows activation status',
            'Review recent hardware changes',
            'Verify license integrity',
            'Check for system file modifications'
        ],
        immediateActions: [
            'Verify Windows activation',
            'Run slmgr /rearm',
            'Contact Microsoft support',
            'Check for unauthorized modifications',
            'Restore from known good backup'
        ]
    },

    0x000000FC: {
        bugCheckCode: 0x000000FC,
        name: 'ATTEMPTED_EXECUTE_OF_NOEXECUTE_MEMORY',
        parameters: {
            param1: { name: 'Virtual Address', description: 'Address of attempted execution' },
            param2: { name: 'Page Table Entry', description: 'Contents of page table entry' },
            param3: { name: 'Reserved', description: 'Reserved' },
            param4: { name: 'Reserved', description: 'Reserved' }
        },
        commonCauses: [
            'Driver attempting to execute data pages',
            'DEP (Data Execution Prevention) violation',
            'Buffer overflow exploit attempts',
            'Corrupted driver code',
            'Malware activity'
        ],
        diagnosticSteps: [
            'Identify driver from virtual address',
            'Check DEP configuration',
            'Look for exploit patterns',
            'Review security logs'
        ],
        immediateActions: [
            'Update the faulting driver',
            'Verify DEP settings',
            'Scan for malware',
            'Check for driver updates',
            'Enable Driver Verifier'
        ]
    },

    0x000000AB: {
        bugCheckCode: 0x000000AB,
        name: 'SESSION_HAS_VALID_POOL_ON_EXIT',
        parameters: {
            param1: { name: 'Session ID', description: 'Session ID with pool leak' },
            param2: { name: 'Pool Bytes', description: 'Number of bytes not freed' },
            param3: { name: 'Pool Allocations', description: 'Number of allocations not freed' },
            param4: { name: 'Pool Tag', description: 'Pool tag of largest leak' }
        },
        commonCauses: [
            'Graphics driver memory leak',
            'Terminal services driver issues',
            'Session cleanup failure',
            'Third-party driver bugs',
            'Remote desktop problems'
        ],
        diagnosticSteps: [
            'Identify pool tag owner',
            'Check graphics driver version',
            'Review terminal services logs',
            'Look for session cleanup errors'
        ],
        immediateActions: [
            'Update graphics drivers',
            'Disable remote desktop temporarily',
            'Check for driver updates',
            'Use poolmon to track leaks',
            'Restart terminal services'
        ]
    },

    // Boot and Initialization Errors
    0x0000007B: {
        bugCheckCode: 0x0000007B,
        name: 'INACCESSIBLE_BOOT_DEVICE',
        parameters: {
            param1: { name: 'Unicode String', description: 'Address of Unicode string with device name' },
            param2: { name: 'DeviceObject', description: 'Address of device object' },
            param3: { name: 'Reserved', description: 'Reserved' },
            param4: { name: 'Reserved', description: 'Reserved' }
        },
        commonCauses: [
            'Boot device driver failure',
            'Changed SATA mode in BIOS',
            'Corrupted boot device drivers',
            'Hardware configuration changes',
            'Failed Windows update'
        ],
        diagnosticSteps: [
            'Check BIOS SATA mode settings',
            'Verify boot device is detected',
            'Review recent hardware changes',
            'Check boot configuration data'
        ],
        immediateActions: [
            'Check SATA mode (AHCI/IDE/RAID)',
            'Boot from Windows installation media',
            'Run Startup Repair',
            'Rebuild BCD with bootrec',
            'Load last known good configuration'
        ]
    },

    0x000000ED: {
        bugCheckCode: 0x000000ED,
        name: 'UNMOUNTABLE_BOOT_VOLUME',
        parameters: {
            param1: { name: 'Device Object', description: 'Boot volume device object' },
            param2: { name: 'Status Code', description: 'NTSTATUS code for the failure' },
            param3: { name: 'Reserved', description: 'Reserved' },
            param4: { name: 'Reserved', description: 'Reserved' }
        },
        commonCauses: [
            'File system corruption on boot drive',
            'Failed or failing boot drive',
            'Incorrect boot device settings',
            'Damaged boot sector',
            'SATA/IDE cable issues'
        ],
        diagnosticSteps: [
            'Check NTSTATUS code for specific error',
            'Verify boot drive health',
            'Check file system integrity',
            'Review BIOS boot settings'
        ],
        immediateActions: [
            'Run chkdsk /r from recovery',
            'Check and reseat drive cables',
            'Test boot drive health',
            'Repair boot sector with bootrec',
            'Try Safe Mode boot'
        ]
    },

    0x0000006B: {
        bugCheckCode: 0x0000006B,
        name: 'BOOT_INITIALIZATION_FAILED',
        parameters: {
            param1: { name: 'Failure Code', description: 'Specific initialization failure' },
            param2: { name: 'Reserved', description: 'Reserved' },
            param3: { name: 'Reserved', description: 'Reserved' },
            param4: { name: 'Reserved', description: 'Reserved' }
        },
        commonCauses: [
            'Corrupted system files',
            'Failed Windows update',
            'Registry corruption',
            'Missing boot files',
            'Hardware incompatibility'
        ],
        diagnosticSteps: [
            'Identify specific failure from code',
            'Check system file integrity',
            'Review Windows update history',
            'Verify hardware compatibility'
        ],
        immediateActions: [
            'Use System Restore',
            'Run Startup Repair',
            'Boot from installation media',
            'Restore registry from backup',
            'Check for hardware issues'
        ]
    },

    0xC00002E2: {
        bugCheckCode: 0xC00002E2,
        name: 'STATUS_SYSTEM_PROCESS_TERMINATED',
        parameters: {
            param1: { name: 'Process', description: 'Critical process that terminated' },
            param2: { name: 'Reserved', description: 'Reserved' },
            param3: { name: 'Reserved', description: 'Reserved' },
            param4: { name: 'Reserved', description: 'Reserved' }
        },
        commonCauses: [
            'Critical system process crashed',
            'Severe system file corruption',
            'Malware terminating system processes',
            'Failed system update',
            'Hardware failure'
        ],
        diagnosticSteps: [
            'Identify which process terminated',
            'Check for system file corruption',
            'Review system logs',
            'Look for malware activity'
        ],
        immediateActions: [
            'Boot from recovery media',
            'Run sfc /scannow offline',
            'Perform System Restore',
            'Scan for malware offline',
            'Consider Windows repair install'
        ]
    },

    // Memory and Resource Errors
    0x0000002D: {
        bugCheckCode: 0x0000002D,
        name: 'OUT_OF_MEMORY',
        parameters: {
            param1: { name: 'Size', description: 'Size of allocation that failed' },
            param2: { name: 'Pool Type', description: 'Type of pool allocation' },
            param3: { name: 'Reserved', description: 'Reserved' },
            param4: { name: 'Reserved', description: 'Reserved' }
        },
        commonCauses: [
            'Memory leak in driver or application',
            'Insufficient RAM for workload',
            'Page file too small or disabled',
            'Memory fragmentation',
            'Resource exhaustion'
        ],
        diagnosticSteps: [
            'Check available memory at crash',
            'Identify pool type that failed',
            'Look for memory leak patterns',
            'Review resource usage'
        ],
        immediateActions: [
            'Increase page file size',
            'Add more physical RAM',
            'Check for memory leaks',
            'Update problematic drivers',
            'Close unnecessary programs'
        ]
    },

    0x000000DE: {
        bugCheckCode: 0x000000DE,
        name: 'POOL_CORRUPTION_IN_FILE_AREA',
        parameters: {
            param1: { name: 'Pool Address', description: 'Address of corrupted pool' },
            param2: { name: 'Reserved', description: 'Reserved' },
            param3: { name: 'Reserved', description: 'Reserved' },
            param4: { name: 'Reserved', description: 'Reserved' }
        },
        commonCauses: [
            'File system filter driver bug',
            'Antivirus software issues',
            'Backup software conflicts',
            'Storage driver corruption',
            'Memory hardware errors'
        ],
        diagnosticSteps: [
            'Identify pool tag from corruption',
            'Check for filter drivers',
            'Review antivirus activity',
            'Look for storage errors'
        ],
        immediateActions: [
            'Disable file system filters',
            'Update antivirus software',
            'Check storage drivers',
            'Run memory diagnostic',
            'Use Driver Verifier'
        ]
    },

    0x00000019: {
        bugCheckCode: 0x00000019,
        name: 'BAD_POOL_HEADER',
        parameters: {
            param1: { name: 'Pool Header', description: 'Contents of corrupted pool header' },
            param2: { name: 'Pool Address', description: 'Address of pool allocation' },
            param3: { name: 'Reserved', description: 'Reserved' },
            param4: { name: 'Reserved', description: 'Reserved' }
        },
        commonCauses: [
            'Driver corrupting pool memory',
            'Hardware memory errors',
            'Overclocking instability',
            'Faulty device drivers',
            'Software bugs'
        ],
        diagnosticSteps: [
            'Examine pool header corruption pattern',
            'Identify pool tag if possible',
            'Check for driver updates',
            'Test system memory'
        ],
        immediateActions: [
            'Run Windows Memory Diagnostic',
            'Update all drivers',
            'Disable overclocking',
            'Enable Driver Verifier',
            'Check for BIOS updates'
        ]
    },

    0x0000004E: {
        bugCheckCode: 0x0000004E,
        name: 'PFN_LIST_CORRUPT',
        parameters: {
            param1: { name: 'Parameter 1', description: 'Type of inconsistency' },
            param2: { name: 'Parameter 2', description: 'Address of PFN' },
            param3: { name: 'Parameter 3', description: 'Page frame number\'s page state' },
            param4: { name: 'Parameter 4', description: 'Page frame number' }
        },
        commonCauses: [
            'Hardware memory failure',
            'Driver corrupting system structures',
            'Overclocking causing instability',
            'Motherboard issues',
            'Power supply problems'
        ],
        diagnosticSteps: [
            'Check type of PFN corruption',
            'Test memory thoroughly',
            'Review driver list',
            'Check system temperatures'
        ],
        immediateActions: [
            'Run extended memory tests',
            'Remove overclocking',
            'Update chipset drivers',
            'Check power supply',
            'Test with minimal RAM'
        ]
    },

    // Network and Communication Errors
    0x00000165: {
        bugCheckCode: 0x00000165,
        name: 'TCPIP_AOAC_NIC_ACTIVE_REFERENCE_LEAK',
        parameters: {
            param1: { name: 'Leaked Reference', description: 'The leaked active reference' },
            param2: { name: 'Network Adapter', description: 'Network adapter with leak' },
            param3: { name: 'Reserved', description: 'Reserved' },
            param4: { name: 'Reserved', description: 'Reserved' }
        },
        commonCauses: [
            'Network driver power management bug',
            'Always On Always Connected issues',
            'Network adapter firmware problems',
            'Power state transition failures',
            'Driver reference counting errors'
        ],
        diagnosticSteps: [
            'Identify network adapter involved',
            'Check power management settings',
            'Review network driver version',
            'Look for AOAC compatibility'
        ],
        immediateActions: [
            'Update network adapter drivers',
            'Disable AOAC features',
            'Disable adapter power management',
            'Update network firmware',
            'Check for Windows updates'
        ]
    },

    0x0000006C: {
        bugCheckCode: 0x0000006C,
        name: 'NETWORK_BOOT_INITIALIZATION_FAILED',
        parameters: {
            param1: { name: 'Failure Code', description: 'Specific network boot failure' },
            param2: { name: 'Reserved', description: 'Reserved' },
            param3: { name: 'Reserved', description: 'Reserved' },
            param4: { name: 'Reserved', description: 'Reserved' }
        },
        commonCauses: [
            'Network boot configuration error',
            'PXE boot failure',
            'Network adapter initialization failure',
            'Boot image not found',
            'DHCP/TFTP issues'
        ],
        diagnosticSteps: [
            'Check network boot settings',
            'Verify PXE configuration',
            'Test network connectivity',
            'Review boot server logs'
        ],
        immediateActions: [
            'Verify network boot configuration',
            'Check PXE server availability',
            'Test network adapter',
            'Review BIOS network settings',
            'Try local boot instead'
        ]
    },

    0x0000007C: {
        bugCheckCode: 0x0000007C,
        name: 'NDIS_INTERNAL_ERROR',
        parameters: {
            param1: { name: 'NDIS Error Code', description: 'Specific NDIS error' },
            param2: { name: 'Parameter 1', description: 'Depends on error code' },
            param3: { name: 'Parameter 2', description: 'Depends on error code' },
            param4: { name: 'Parameter 3', description: 'Depends on error code' }
        },
        commonCauses: [
            'Network driver internal error',
            'NDIS corruption',
            'Miniport driver failure',
            'Protocol driver issues',
            'Network stack corruption'
        ],
        diagnosticSteps: [
            'Identify NDIS error code',
            'Check network driver versions',
            'Review network configuration',
            'Look for driver conflicts'
        ],
        immediateActions: [
            'Update network drivers',
            'Reset network stack',
            'Remove and reinstall adapters',
            'Check for driver conflicts',
            'Run network diagnostics'
        ]
    },

    // USB and External Device Errors
    0x000000FE: {
        bugCheckCode: 0x000000FE,
        name: 'BUGCODE_USB_DRIVER',
        parameters: {
            param1: { name: 'USB Error Code', description: 'Specific USB error' },
            param2: { name: 'Parameter 1', description: 'Depends on error code' },
            param3: { name: 'Parameter 2', description: 'Depends on error code' },
            param4: { name: 'Parameter 3', description: 'Depends on error code' }
        },
        commonCauses: [
            'USB driver bug',
            'Faulty USB device',
            'USB controller issues',
            'Power management conflicts',
            'USB hub problems'
        ],
        diagnosticSteps: [
            'Identify specific USB error',
            'Check connected USB devices',
            'Review USB driver versions',
            'Test USB ports individually'
        ],
        immediateActions: [
            'Remove all USB devices',
            'Update USB controller drivers',
            'Disable USB selective suspend',
            'Test with different USB ports',
            'Check for firmware updates'
        ]
    },

    0x00000180: {
        bugCheckCode: 0x00000180,
        name: 'USB_DRIPS_BLOCKER_SURPRISE_REMOVAL_LIVEDUMP',
        parameters: {
            param1: { name: 'USB Device', description: 'Device that was removed' },
            param2: { name: 'Reserved', description: 'Reserved' },
            param3: { name: 'Reserved', description: 'Reserved' },
            param4: { name: 'Reserved', description: 'Reserved' }
        },
        commonCauses: [
            'USB device surprise removal during sleep',
            'Power management timing issue',
            'USB driver not handling removal',
            'DRIPS (Deepest Runtime Idle Platform State) conflict',
            'USB hub power issues'
        ],
        diagnosticSteps: [
            'Identify removed USB device',
            'Check power management logs',
            'Review DRIPS configuration',
            'Test USB device stability'
        ],
        immediateActions: [
            'Safely remove USB devices',
            'Update USB drivers',
            'Disable USB power management',
            'Check USB hub power',
            'Update device firmware'
        ]
    },

    0x00000166: {
        bugCheckCode: 0x00000166,
        name: 'INVALID_USB_DESCRIPTOR',
        parameters: {
            param1: { name: 'USB Device Object', description: 'Device with invalid descriptor' },
            param2: { name: 'Descriptor Type', description: 'Type of invalid descriptor' },
            param3: { name: 'Reserved', description: 'Reserved' },
            param4: { name: 'Reserved', description: 'Reserved' }
        },
        commonCauses: [
            'Faulty USB device',
            'Corrupted USB firmware',
            'Incompatible USB device',
            'USB descriptor corruption',
            'Non-compliant USB implementation'
        ],
        diagnosticSteps: [
            'Identify problematic USB device',
            'Check descriptor type',
            'Test device on another system',
            'Review USB compatibility'
        ],
        immediateActions: [
            'Remove the faulty USB device',
            'Update device firmware',
            'Try different USB port',
            'Check device compatibility',
            'Replace if defective'
        ]
    },

    // Graphics and Display Errors
    0x00000116: {
        bugCheckCode: 0x00000116,
        name: 'VIDEO_TDR_FAILURE',
        parameters: {
            param1: { name: 'Device Object', description: 'GPU device object pointer' },
            param2: { name: 'TDR Recovery Reason', description: 'Reason for TDR' },
            param3: { name: 'Reserved', description: 'Reserved' },
            param4: { name: 'Reserved', description: 'Reserved' }
        },
        commonCauses: [
            'GPU driver timeout',
            'Overheating graphics card',
            'GPU overclock instability',
            'Faulty GPU hardware',
            'Driver bugs'
        ],
        diagnosticSteps: [
            'Check GPU temperatures',
            'Review TDR recovery reason',
            'Test with different driver version',
            'Monitor GPU usage'
        ],
        immediateActions: [
            'Update graphics drivers',
            'Check GPU cooling',
            'Remove GPU overclock',
            'Increase TDR timeout',
            'Test with different GPU'
        ],
        relatedDrivers: ['nvlddmkm.sys', 'atikmdag.sys', 'igdkmd64.sys', 'dxgkrnl.sys']
    },

    0x00000119: {
        bugCheckCode: 0x00000119,
        name: 'VIDEO_SCHEDULER_INTERNAL_ERROR',
        parameters: {
            param1: { name: 'Error Code', description: 'Video scheduler error' },
            param2: { name: 'Parameter 1', description: 'Depends on error code' },
            param3: { name: 'Parameter 2', description: 'Depends on error code' },
            param4: { name: 'Parameter 3', description: 'Depends on error code' }
        },
        commonCauses: [
            'GPU driver corruption',
            'Video memory errors',
            'DirectX issues',
            'Hardware acceleration problems',
            'GPU hardware failure'
        ],
        diagnosticSteps: [
            'Identify scheduler error code',
            'Check video memory integrity',
            'Test DirectX functionality',
            'Review GPU hardware status'
        ],
        immediateActions: [
            'Reinstall graphics drivers',
            'Disable hardware acceleration',
            'Run DirectX diagnostics',
            'Test with basic display driver',
            'Check GPU seating'
        ]
    },

    0x0000010E: {
        bugCheckCode: 0x0000010E,
        name: 'VIDEO_MEMORY_MANAGEMENT_INTERNAL',
        parameters: {
            param1: { name: 'Error Type', description: 'Video memory error type' },
            param2: { name: 'Parameter 1', description: 'Depends on error type' },
            param3: { name: 'Parameter 2', description: 'Depends on error type' },
            param4: { name: 'Parameter 3', description: 'Depends on error type' }
        },
        commonCauses: [
            'Video memory corruption',
            'VRAM hardware failure',
            'GPU driver memory management bug',
            'Overclocked video memory',
            'Heat damage to GPU'
        ],
        diagnosticSteps: [
            'Check VRAM error patterns',
            'Monitor GPU memory usage',
            'Test with memory stress tools',
            'Check for artifacts'
        ],
        immediateActions: [
            'Remove VRAM overclock',
            'Update GPU drivers',
            'Test GPU in another system',
            'Run GPU memory tests',
            'Check thermal pads on VRAM'
        ]
    },

    0x00000117: {
        bugCheckCode: 0x00000117,
        name: 'DISPLAY_DRIVER_STOPPED_RESPONDING',
        parameters: {
            param1: { name: 'Device Object', description: 'Display adapter device' },
            param2: { name: 'Reserved', description: 'Reserved' },
            param3: { name: 'Reserved', description: 'Reserved' },
            param4: { name: 'Reserved', description: 'Reserved' }
        },
        commonCauses: [
            'Display driver hang',
            'GPU not responding to commands',
            'Display cable issues',
            'Monitor compatibility problems',
            'GPU power delivery issues'
        ],
        diagnosticSteps: [
            'Check display connections',
            'Test with different monitor',
            'Verify GPU power connectors',
            'Check for driver timeouts'
        ],
        immediateActions: [
            'Clean install display drivers',
            'Check display cables',
            'Test different display outputs',
            'Verify PSU can handle GPU',
            'Reduce display resolution'
        ]
    },

    // Virtualization and Hyper-V Errors
    0x00020001: {
        bugCheckCode: 0x00020001,
        name: 'HYPERVISOR_ERROR',
        parameters: {
            param1: { name: 'Message Type', description: 'Hypervisor message type' },
            param2: { name: 'Parameter 1', description: 'Message specific' },
            param3: { name: 'Parameter 2', description: 'Message specific' },
            param4: { name: 'Parameter 3', description: 'Message specific' }
        },
        commonCauses: [
            'Hypervisor initialization failure',
            'Virtualization hardware issues',
            'BIOS virtualization disabled',
            'Hyper-V configuration error',
            'Incompatible CPU features'
        ],
        diagnosticSteps: [
            'Check virtualization in BIOS',
            'Verify CPU supports virtualization',
            'Review Hyper-V configuration',
            'Check for conflicts'
        ],
        immediateActions: [
            'Enable virtualization in BIOS',
            'Update Hyper-V integration',
            'Check Windows features',
            'Verify hardware compatibility',
            'Update system firmware'
        ]
    },

    0x00000151: {
        bugCheckCode: 0x00000151,
        name: 'VMBUS_VIRTUAL_PROCESSOR_LIMIT_EXCEEDED',
        parameters: {
            param1: { name: 'Current VP Count', description: 'Current virtual processor count' },
            param2: { name: 'VP Limit', description: 'Virtual processor limit' },
            param3: { name: 'Reserved', description: 'Reserved' },
            param4: { name: 'Reserved', description: 'Reserved' }
        },
        commonCauses: [
            'Too many virtual processors configured',
            'Hyper-V host limitations',
            'License restrictions',
            'Hardware limitations',
            'Configuration error'
        ],
        diagnosticSteps: [
            'Check VP configuration',
            'Review host capabilities',
            'Verify licensing limits',
            'Check hardware specs'
        ],
        immediateActions: [
            'Reduce virtual processor count',
            'Check Hyper-V host limits',
            'Review VM configuration',
            'Update Hyper-V version',
            'Check licensing'
        ]
    },

    // Additional Critical Errors
    0x0000007F: {
        bugCheckCode: 0x0000007F,
        name: 'UNEXPECTED_KERNEL_MODE_TRAP',
        parameters: {
            param1: { name: 'Trap Number', description: 'Intel trap number' },
            param2: { name: 'Reserved', description: 'Reserved' },
            param3: { name: 'Reserved', description: 'Reserved' },
            param4: { name: 'Reserved', description: 'Reserved' }
        },
        commonCauses: [
            'Hardware failure (CPU, memory, motherboard)',
            'Overclocking instability',
            'Overheating',
            'Incompatible hardware',
            'BIOS bugs'
        ],
        diagnosticSteps: [
            'Check trap number for specific cause',
            'Monitor temperatures',
            'Test hardware components',
            'Review overclocking settings'
        ],
        immediateActions: [
            'Remove all overclocking',
            'Check CPU and system cooling',
            'Test RAM thoroughly',
            'Update BIOS',
            'Run hardware diagnostics'
        ]
    },

    0x00000018: {
        bugCheckCode: 0x00000018,
        name: 'REFERENCE_BY_POINTER',
        parameters: {
            param1: { name: 'Object Type', description: 'Type of object' },
            param2: { name: 'Object', description: 'Object address' },
            param3: { name: 'Reserved', description: 'Reserved' },
            param4: { name: 'Reserved', description: 'Reserved' }
        },
        commonCauses: [
            'Driver reference counting bug',
            'Object already freed',
            'Synchronization issues',
            'Driver unload problems',
            'Corrupted object headers'
        ],
        diagnosticSteps: [
            'Identify object type',
            'Find driver managing object',
            'Check for race conditions',
            'Review driver unload sequence'
        ],
        immediateActions: [
            'Update problematic driver',
            'Enable Driver Verifier',
            'Check for driver conflicts',
            'Review recent driver installs',
            'Test in Safe Mode'
        ]
    },

    0x000000E1: {
        bugCheckCode: 0x000000E1,
        name: 'WORKER_THREAD_RETURNED_AT_BAD_IRQL',
        parameters: {
            param1: { name: 'Worker Routine', description: 'Address of worker routine' },
            param2: { name: 'IRQL', description: 'Current IRQL' },
            param3: { name: 'Work Item', description: 'Work item address' },
            param4: { name: 'Reserved', description: 'Reserved' }
        },
        commonCauses: [
            'Driver not restoring IRQL properly',
            'Work item corruption',
            'Synchronization problems',
            'Driver bugs in DPC routines',
            'Improper spinlock usage'
        ],
        diagnosticSteps: [
            'Identify worker routine',
            'Check IRQL transitions',
            'Review driver work items',
            'Look for spinlock issues'
        ],
        immediateActions: [
            'Update driver with bad routine',
            'Enable Driver Verifier',
            'Check for driver updates',
            'Review driver documentation',
            'Contact driver vendor'
        ]
    }
};

// Helper function to get detailed parameter explanation
export function getParameterExplanation(bugCheckCode: number, paramNumber: 1 | 2 | 3 | 4, value: bigint): string {
    const pattern = CRASH_PATTERN_DATABASE[bugCheckCode];
    if (!pattern) return `Unknown parameter for bug check 0x${bugCheckCode.toString(16)}`;

    const paramName = `param${paramNumber}` as keyof typeof pattern.parameters;
    const paramInfo = pattern.parameters[paramName];
    
    let explanation = `${paramInfo.name}: ${paramInfo.description}\n`;
    explanation += `Value: 0x${value.toString(16)}\n`;

    // Add specific interpretations based on bug check and parameter
    switch (bugCheckCode) {
        case 0x0000000A: // IRQL_NOT_LESS_OR_EQUAL
        case 0x000000D1: // DRIVER_IRQL_NOT_LESS_OR_EQUAL
            if (paramNumber === 2) {
                explanation += `IRQL Level: ${getIrqlName(Number(value))}`;
            } else if (paramNumber === 3) {
                explanation += `Access Type: ${value === 0n ? 'Read' : value === 1n ? 'Write' : 'Execute'}`;
            }
            break;

        case 0x00000050: // PAGE_FAULT_IN_NONPAGED_AREA
            if (paramNumber === 2) {
                const accessType = Number(value);
                if (accessType === 0) explanation += 'Access Type: Read';
                else if (accessType === 1) explanation += 'Access Type: Write';
                else if (accessType === 2) explanation += 'Access Type: Execute';
                else if (accessType === 10) explanation += 'Access Type: Execute (DEP violation)';
            }
            break;

        case 0x000000C2: // BAD_POOL_CALLER
            if (paramNumber === 1) {
                explanation += getPoolViolationType(Number(value));
            }
            break;

        case 0x00000139: // KERNEL_SECURITY_CHECK_FAILURE
            if (paramNumber === 1) {
                explanation += getSecurityCheckType(Number(value));
            }
            break;
    }

    return explanation;
}

function getIrqlName(irql: number): string {
    const irqlNames: Record<number, string> = {
        0: 'PASSIVE_LEVEL',
        1: 'APC_LEVEL',
        2: 'DISPATCH_LEVEL',
        3: 'CMCI_LEVEL',
        4: 'DEVICE_LEVEL',
        11: 'HIGH_LEVEL'
    };
    return irqlNames[irql] || `IRQL ${irql}`;
}

function getPoolViolationType(type: number): string {
    const violations: Record<number, string> = {
        0x00: 'Unknown pool corruption',
        0x01: 'Pool header corruption',
        0x02: 'Pool header size corruption',
        0x06: 'Attempt to free pool at invalid address',
        0x07: 'Attempt to free pool already freed',
        0x08: 'Quota process pointer corrupt',
        0x09: 'Pool allocation contains ERESOURCE',
        0x0A: 'Attempt to free pool with active timer',
        0x0B: 'Memory manager structures corrupt',
        0x0C: 'Attempt to mix session pool and other pool',
        0x41: 'Pool quota cookie corrupt',
        0x42: 'Pool freed by wrong thread',
        0x43: 'Pool double freed',
        0x44: 'Pool corrupted by driver using it after free',
        0x46: 'Pool tracked table corrupt',
        0x47: 'Pool tracking structures corrupt',
        0x48: 'Cannot find pool allocation in tracker',
        0x49: 'Pool allocation not tracked',
        0x99: 'Pool page header corrupt'
    };
    return violations[type] || `Pool violation type 0x${type.toString(16)}`;
}

function getSecurityCheckType(type: number): string {
    const checkTypes: Record<number, string> = {
        0x00: 'Unknown security check failure',
        0x01: 'FAST_FAIL_GUARD_ICALL_CHECK_FAILURE',
        0x02: 'FAST_FAIL_STACK_COOKIE_CHECK_FAILURE',
        0x03: 'FAST_FAIL_CORRUPT_LIST_ENTRY',
        0x04: 'FAST_FAIL_INCORRECT_STACK',
        0x05: 'FAST_FAIL_INVALID_ARG',
        0x06: 'FAST_FAIL_GS_COOKIE_INIT',
        0x07: 'FAST_FAIL_FATAL_APP_EXIT',
        0x08: 'FAST_FAIL_RANGE_CHECK_FAILURE',
        0x09: 'FAST_FAIL_UNSAFE_REGISTRY_ACCESS',
        0x0A: 'FAST_FAIL_GUARD_ICALL_CHECK_SUPPRESSED',
        0x0B: 'FAST_FAIL_INVALID_FIBER_SWITCH',
        0x0C: 'FAST_FAIL_INVALID_SET_OF_CONTEXT',
        0x0D: 'FAST_FAIL_INVALID_REFERENCE_COUNT',
        0x14: 'FAST_FAIL_INVALID_JUMP_BUFFER',
        0x15: 'FAST_FAIL_MRDATA_MODIFIED',
        0x16: 'FAST_FAIL_CERTIFICATION_FAILURE',
        0x17: 'FAST_FAIL_INVALID_EXCEPTION_CHAIN',
        0x18: 'FAST_FAIL_CRYPTO_LIBRARY',
        0x19: 'FAST_FAIL_INVALID_CALL_IN_DLL_CALLOUT',
        0x1A: 'FAST_FAIL_INVALID_IMAGE_BASE',
        0x1B: 'FAST_FAIL_DLOAD_PROTECTION_FAILURE',
        0x1C: 'FAST_FAIL_UNSAFE_EXTENSION_CALL'
    };
    return checkTypes[type] || `Security check type 0x${type.toString(16)}`;
}

// Get recommended analysis approach for a bug check
export function getAnalysisStrategy(bugCheckCode: number): {
    priority: 'critical' | 'high' | 'medium' | 'low';
    focusAreas: string[];
    toolsNeeded: string[];
} {
    const hardwareErrors = [0x124, 0x9C, 0x101, 0x19, 0x1A];
    const securityErrors = [0x139, 0x109, 0x18C, 0x18E];
    const driverErrors = [0xD1, 0xA, 0xC4, 0xC9, 0xDA];
    
    if (hardwareErrors.includes(bugCheckCode)) {
        return {
            priority: 'critical',
            focusAreas: ['Hardware diagnostics', 'Temperature monitoring', 'Power supply', 'Memory testing'],
            toolsNeeded: ['MemTest86+', 'CPU stress test', 'Hardware monitor', 'SMART disk check']
        };
    } else if (securityErrors.includes(bugCheckCode)) {
        return {
            priority: 'high',
            focusAreas: ['Security mitigation', 'Exploit detection', 'Driver verification', 'Malware scan'],
            toolsNeeded: ['Driver Verifier', 'Anti-malware tools', 'System file checker', 'Security logs']
        };
    } else if (driverErrors.includes(bugCheckCode)) {
        return {
            priority: 'medium',
            focusAreas: ['Driver analysis', 'IRQL verification', 'Pool tracking', 'Stack analysis'],
            toolsNeeded: ['Driver Verifier', 'Pool monitor', 'IRP tracker', 'Device Manager']
        };
    } else {
        return {
            priority: 'medium',
            focusAreas: ['General system health', 'Recent changes', 'Event logs', 'Driver updates'],
            toolsNeeded: ['Event Viewer', 'System restore', 'Update checker', 'Safe mode']
        };
    }
}