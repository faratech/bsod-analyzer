/**
 * Symbol data that can be gathered and stored in the database
 */

// 1. Core Windows System Symbols (Legal to include)
export const GATHERABLE_SYMBOLS = {
    // Microsoft publicly documents these in WDK/DDK
    systemModules: [
        'ntoskrnl.exe',      // Windows kernel - thousands of exported functions
        'hal.dll',           // Hardware abstraction layer
        'win32k.sys',        // Win32 subsystem
        'ndis.sys',          // Network stack
        'tcpip.sys',         // TCP/IP implementation
        'http.sys',          // HTTP protocol
        'afd.sys',           // Ancillary Function Driver
        'rdbss.sys',         // Redirected Drive Buffering
        'mrxsmb.sys',        // SMB client
        'fltmgr.sys',        // Filter Manager
        'ntfs.sys',          // NTFS file system
        'fastfat.sys',       // FAT file system
        'exfat.sys',         // ExFAT file system
        'volsnap.sys',       // Volume Shadow Copy
        'partmgr.sys',       // Partition Manager
        'disk.sys',          // Disk driver
        'storport.sys',      // Storage port driver
        'ataport.sys',       // ATA port driver
        'acpi.sys',          // ACPI driver
        'pci.sys',           // PCI bus driver
        'usb*.sys',          // USB drivers
        'hidclass.sys',      // HID class driver
        'ks.sys',            // Kernel streaming
        'portcls.sys',       // Port class audio
        'dxgkrnl.sys',       // DirectX Graphics Kernel
        'dxgmms*.sys',       // DirectX Graphics Memory Manager
        'cng.sys',           // Cryptography Next Generation
        'ksecdd.sys',        // Kernel Security Support Provider
        'msrpc.sys',         // Microsoft RPC
        'srv.sys',           // Server driver
        'srv2.sys',          // Server driver v2
        'srvnet.sys',        // Server network driver
        'bowser.sys',        // Browser service
        'mup.sys',           // Multiple UNC Provider
        'dfsc.sys',          // DFS client
        'wof.sys',           // Windows Overlay Filter
        'wcifs.sys',         // Windows Container Isolation
        'cldflt.sys',        // Cloud Files filter
        'storqosflt.sys',    // Storage QoS filter
        'bam.sys',           // Background Activity Moderator
        'ahcache.sys',       // Application Compatibility Cache
        'mmcss.sys',         // Multimedia Class Scheduler
        'luafv.sys',         // LUA File Virtualization
        'fileinfo.sys',      // File Information filter
        'wcnfs.sys',         // Windows Container Named Pipe
        'bindflt.sys',       // Bind filter driver
        'vmbus.sys',         // Hyper-V VMBus
        'vmswitch.sys',      // Hyper-V Virtual Switch
        'winhv.sys',         // Windows Hypervisor
        'hvservice.sys',     // Hyper-V Integration Services
    ],

    // These symbols are documented in Windows SDK/WDK
    documentedExports: {
        'ntoskrnl.exe': [
            // Memory Management
            'ExAllocatePool', 'ExAllocatePoolWithTag', 'ExFreePool', 'ExFreePoolWithTag',
            'MmAllocateContiguousMemory', 'MmFreeContiguousMemory', 'MmMapIoSpace', 'MmUnmapIoSpace',
            'MmProbeAndLockPages', 'MmUnlockPages', 'MmBuildMdlForNonPagedPool', 'MmMapLockedPagesSpecifyCache',
            
            // Synchronization
            'KeInitializeSpinLock', 'KeAcquireSpinLock', 'KeReleaseSpinLock', 'KeAcquireSpinLockAtDpcLevel',
            'KeInitializeMutex', 'KeWaitForSingleObject', 'KeSetEvent', 'KeClearEvent', 'KeResetEvent',
            'KeInitializeSemaphore', 'KeReleaseSemaphore', 'KeInitializeTimer', 'KeSetTimer',
            
            // I/O Management  
            'IoCreateDevice', 'IoDeleteDevice', 'IoCreateSymbolicLink', 'IoDeleteSymbolicLink',
            'IoCompleteRequest', 'IoCallDriver', 'IoBuildSynchronousFsdRequest', 'IoBuildAsynchronousFsdRequest',
            'IoAllocateIrp', 'IoFreeIrp', 'IoAllocateMdl', 'IoFreeMdl',
            
            // Process/Thread Management
            'PsCreateSystemThread', 'PsTerminateSystemThread', 'PsGetCurrentProcess', 'PsGetCurrentThread',
            'ZwCreateProcess', 'ZwTerminateProcess', 'ZwOpenProcess', 'ZwClose',
            
            // Registry
            'ZwCreateKey', 'ZwOpenKey', 'ZwSetValueKey', 'ZwQueryValueKey', 'ZwDeleteKey',
            
            // Security
            'SeAccessCheck', 'SeLockSubjectContext', 'SeUnlockSubjectContext', 'SeAssignSecurity',
            
            // Object Management
            'ObReferenceObjectByHandle', 'ObDereferenceObject', 'ObReferenceObjectByPointer',
            
            // Bug Check
            'KeBugCheck', 'KeBugCheckEx', 'KiPageFault', 'KiGeneralProtectionFault', 'KiDoubleFaultAbort',
            
            // DPC/ISR
            'KeInitializeDpc', 'KeInsertQueueDpc', 'KeRemoveQueueDpc', 'KeSynchronizeExecution',
            'KeAcquireInterruptSpinLock', 'KeReleaseInterruptSpinLock',
        ]
    }
};

// 2. Information we can gather from the client's crash dumps
export interface GatherableClientData {
    // Module information from dumps
    modules: Array<{
        name: string;
        baseAddress: number;
        size: number;
        timestamp: number;
        checksum: number;
        pdbInfo?: {
            guid: string;
            age: number;
            path: string;
        };
    }>;

    // Actual symbol mappings found in dumps
    resolvedSymbols: Array<{
        address: number;
        module: string;
        symbol: string;
        offset: number;
    }>;

    // Common crash patterns
    crashPatterns: Array<{
        bugCheckCode: number;
        frequentModules: string[];
        commonStackFrames: string[];
    }>;

    // Driver versions
    driverVersions: Array<{
        name: string;
        version: string;
        date: string;
        provider: string;
    }>;
}

// 3. Symbol gathering from crash dumps
export class ClientSymbolGatherer {
    private collectedData: GatherableClientData = {
        modules: [],
        resolvedSymbols: [],
        crashPatterns: [],
        driverVersions: []
    };

    /**
     * Gather symbol information from a crash dump
     */
    gatherFromDump(buffer: ArrayBuffer, structuredInfo: any): GatherableClientData {
        // Collect module information
        if (structuredInfo.moduleList) {
            for (const module of structuredInfo.moduleList) {
                this.collectedData.modules.push({
                    name: module.name,
                    baseAddress: module.baseAddress || 0,
                    size: module.size || 0,
                    timestamp: module.timestamp || 0,
                    checksum: module.checksum || 0,
                    pdbInfo: module.cvRecord ? {
                        guid: module.cvRecord.guid || '',
                        age: module.cvRecord.age || 0,
                        path: module.cvRecord.pdbFileName || ''
                    } : undefined
                });
            }
        }

        // Extract any symbol names found in strings
        const strings = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
        const symbolPatterns = [
            /([a-zA-Z_][a-zA-Z0-9_]+)!([a-zA-Z_][a-zA-Z0-9_]+)(?:\+0x[0-9a-fA-F]+)?/g,
            /^([a-zA-Z_][a-zA-Z0-9_]+)$/gm // Exported function names
        ];

        for (const pattern of symbolPatterns) {
            const matches = strings.matchAll(pattern);
            for (const match of matches) {
                if (match[2]) { // module!symbol format
                    this.collectedData.resolvedSymbols.push({
                        address: 0, // Would need to correlate with actual addresses
                        module: match[1],
                        symbol: match[2],
                        offset: 0
                    });
                }
            }
        }

        // Collect crash pattern data
        if (structuredInfo.bugCheckInfo) {
            const pattern = {
                bugCheckCode: structuredInfo.bugCheckInfo.code,
                frequentModules: this.collectedData.modules.map(m => m.name).slice(0, 10),
                commonStackFrames: [] as string[]
            };
            this.collectedData.crashPatterns.push(pattern);
        }

        return this.collectedData;
    }

    /**
     * Generate anonymized statistics for crowd-sourcing
     */
    generateStatistics(): any {
        return {
            totalModules: this.collectedData.modules.length,
            uniqueSymbols: new Set(this.collectedData.resolvedSymbols.map(s => s.symbol)).size,
            commonModules: this.getMostCommonModules(),
            crashDistribution: this.getCrashDistribution(),
            // No personally identifiable information
        };
    }

    private getMostCommonModules(): Array<{name: string, count: number}> {
        const counts = new Map<string, number>();
        for (const module of this.collectedData.modules) {
            counts.set(module.name, (counts.get(module.name) || 0) + 1);
        }
        return Array.from(counts.entries())
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 20);
    }

    private getCrashDistribution(): Array<{code: string, count: number}> {
        const counts = new Map<number, number>();
        for (const pattern of this.collectedData.crashPatterns) {
            counts.set(pattern.bugCheckCode, (counts.get(pattern.bugCheckCode) || 0) + 1);
        }
        return Array.from(counts.entries())
            .map(([code, count]) => ({ 
                code: `0x${code.toString(16).padStart(8, '0').toUpperCase()}`,
                count 
            }))
            .sort((a, b) => b.count - a.count);
    }
}

// 4. Privacy-preserving symbol aggregation
export class SymbolAggregator {
    /**
     * Aggregate symbols from multiple dumps while preserving privacy
     */
    static aggregate(gatheredData: GatherableClientData[]): any {
        const aggregated = {
            // Module popularity (which modules appear most in crashes)
            moduleFrequency: new Map<string, number>(),
            
            // Symbol frequency (which functions appear most in stack traces)
            symbolFrequency: new Map<string, number>(),
            
            // Crash patterns
            crashPatterns: new Map<string, Array<string>>(),
            
            // Version information (anonymized)
            commonVersions: new Map<string, Set<string>>(),
        };

        for (const data of gatheredData) {
            // Aggregate module data
            for (const module of data.modules) {
                const key = module.name.toLowerCase();
                aggregated.moduleFrequency.set(key, 
                    (aggregated.moduleFrequency.get(key) || 0) + 1
                );
            }

            // Aggregate symbol data
            for (const symbol of data.resolvedSymbols) {
                const key = `${symbol.module}!${symbol.symbol}`;
                aggregated.symbolFrequency.set(key,
                    (aggregated.symbolFrequency.get(key) || 0) + 1
                );
            }
        }

        return {
            topModules: Array.from(aggregated.moduleFrequency.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 100),
            topSymbols: Array.from(aggregated.symbolFrequency.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 500),
        };
    }
}

// 5. Legal sources for symbol data
export const LEGAL_SYMBOL_SOURCES = {
    // Public Microsoft sources
    microsoft: [
        'Windows Driver Kit (WDK) - Contains public symbols',
        'Windows SDK - Exported functions',
        'Public symbol packages from Microsoft',
        'Microsoft documentation and header files',
        'Debug symbols from open-source Microsoft projects',
    ],

    // Analysis of public crash dumps
    publicDumps: [
        'Crash dumps shared in public forums',
        'Open-source project crash reports',
        'Anonymized aggregate data from users who opt-in',
        'Public bug reports with stack traces',
    ],

    // Reverse engineering (where legal)
    legalRE: [
        'Exported function names (always visible)',
        'Import/Export tables from PE files',
        'Debug information in public binaries',
        'String references in binaries',
    ]
};