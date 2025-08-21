/**
 * Kernel dump header parser for full Windows crash dumps
 * Handles DUMP_HEADER64 and KdDebuggerDataBlock structures
 */

import { parseContext, ParsedContext } from './contextParser.js';

// DUMP_HEADER64 structure offsets
const DUMP_HEADER64_OFFSETS = {
    Signature: 0x0,              // 4 bytes - 'PAGE' or 'DUMP'
    ValidDump: 0x4,              // 4 bytes - 'DU64' or 'DUMP'
    MajorVersion: 0x8,           // 4 bytes
    MinorVersion: 0xC,           // 4 bytes
    DirectoryTableBase: 0x10,    // 8 bytes - CR3 register value
    PfnDataBase: 0x18,           // 8 bytes
    PsLoadedModuleList: 0x20,    // 8 bytes
    PsActiveProcessHead: 0x28,   // 8 bytes
    MachineImageType: 0x30,      // 4 bytes
    NumberProcessors: 0x34,      // 4 bytes
    BugCheckCode: 0x38,          // 4 bytes
    BugCheckParameter1: 0x40,    // 8 bytes
    BugCheckParameter2: 0x48,    // 8 bytes
    BugCheckParameter3: 0x50,    // 8 bytes
    BugCheckParameter4: 0x58,    // 8 bytes
    VersionUser: 0x60,           // 32 bytes - CHAR[32]
    KdDebuggerDataBlock: 0x80,   // 8 bytes - pointer to KDDEBUGGER_DATA64
    PhysicalMemoryBlock: 0x88,   // PHYSICAL_MEMORY_DESCRIPTOR
    // ... Context record starts at 0x348
    ContextRecord: 0x348,        // CONTEXT structure (variable size based on architecture)
    Exception: 0x2000,           // EXCEPTION_RECORD64 at fixed offset in some dumps
};

// KDDEBUGGER_DATA64 structure offsets (partial)
const KDDEBUGGER_DATA64_OFFSETS = {
    Header: 0x0,                 // LIST_ENTRY
    OwnerTag: 0x10,              // 4 bytes - 'KDBG'
    Size: 0x14,                  // 4 bytes
    DebuggerDataList: 0x18,      // LIST_ENTRY
    KernBase: 0x28,              // 8 bytes
    BreakpointWithStatus: 0x30,  // 8 bytes
    SavedContext: 0x38,          // 8 bytes
    ThCallbackStack: 0x40,       // 2 bytes
    NextCallback: 0x42,          // 2 bytes
    FramePointer: 0x44,          // 2 bytes
    KiCallUserMode: 0x50,        // 8 bytes
    KeUserCallbackDispatcher: 0x58, // 8 bytes
    PsLoadedModuleList: 0x60,    // 8 bytes
    PsActiveProcessHead: 0x68,   // 8 bytes
    PspCidTable: 0x70,           // 8 bytes
    ExpSystemResourcesList: 0x78, // 8 bytes
    ExpPagedPoolDescriptor: 0x80, // 8 bytes
    ExpNonPagedPoolDescriptor: 0x88, // 8 bytes
    // ... many more fields
};

// Physical memory descriptor
export interface PhysicalMemoryRun {
    basePage: bigint;
    pageCount: bigint;
}

export interface PhysicalMemoryDescriptor {
    numberOfRuns: number;
    numberOfPages: bigint;
    runs: PhysicalMemoryRun[];
}

export interface KernelDumpHeader {
    signature: string;
    majorVersion: number;
    minorVersion: number;
    directoryTableBase: bigint;  // CR3 register
    pfnDatabase: bigint;
    psLoadedModuleList: bigint;
    psActiveProcessHead: bigint;
    machineImageType: number;
    numberOfProcessors: number;
    bugCheckCode: number;
    bugCheckParameters: bigint[];
    kdDebuggerDataBlock: bigint;
    physicalMemoryDescriptor?: PhysicalMemoryDescriptor;
    context?: ParsedContext;
    kernelBase?: bigint;
}

/**
 * Parse a DUMP_HEADER64 structure from a kernel dump
 */
export function parseKernelDumpHeader(buffer: ArrayBuffer): KernelDumpHeader | null {
    if (buffer.byteLength < 0x2000) {
        console.error('Buffer too small for kernel dump header');
        return null;
    }
    
    const view = new DataView(buffer);
    
    // Check signature
    const sig1 = view.getUint32(DUMP_HEADER64_OFFSETS.Signature, true);
    const sig2 = view.getUint32(DUMP_HEADER64_OFFSETS.ValidDump, true);
    
    // 'PAGE' = 0x45474150, 'DU64' = 0x34365544
    if (sig1 !== 0x45474150 || sig2 !== 0x34365544) {
        console.error('Invalid kernel dump signature');
        return null;
    }
    
    const header: KernelDumpHeader = {
        signature: 'PAGEDU64',
        majorVersion: view.getUint32(DUMP_HEADER64_OFFSETS.MajorVersion, true),
        minorVersion: view.getUint32(DUMP_HEADER64_OFFSETS.MinorVersion, true),
        directoryTableBase: view.getBigUint64(DUMP_HEADER64_OFFSETS.DirectoryTableBase, true),
        pfnDatabase: view.getBigUint64(DUMP_HEADER64_OFFSETS.PfnDataBase, true),
        psLoadedModuleList: view.getBigUint64(DUMP_HEADER64_OFFSETS.PsLoadedModuleList, true),
        psActiveProcessHead: view.getBigUint64(DUMP_HEADER64_OFFSETS.PsActiveProcessHead, true),
        machineImageType: view.getUint32(DUMP_HEADER64_OFFSETS.MachineImageType, true),
        numberOfProcessors: view.getUint32(DUMP_HEADER64_OFFSETS.NumberProcessors, true),
        bugCheckCode: view.getUint32(DUMP_HEADER64_OFFSETS.BugCheckCode, true),
        bugCheckParameters: [
            view.getBigUint64(DUMP_HEADER64_OFFSETS.BugCheckParameter1, true),
            view.getBigUint64(DUMP_HEADER64_OFFSETS.BugCheckParameter2, true),
            view.getBigUint64(DUMP_HEADER64_OFFSETS.BugCheckParameter3, true),
            view.getBigUint64(DUMP_HEADER64_OFFSETS.BugCheckParameter4, true),
        ],
        kdDebuggerDataBlock: view.getBigUint64(DUMP_HEADER64_OFFSETS.KdDebuggerDataBlock, true),
    };
    
    // Parse physical memory descriptor
    try {
        const physMemOffset = DUMP_HEADER64_OFFSETS.PhysicalMemoryBlock;
        const numberOfRuns = view.getUint32(physMemOffset, true);
        const numberOfPages = view.getBigUint64(physMemOffset + 8, true);
        
        const runs: PhysicalMemoryRun[] = [];
        let runOffset = physMemOffset + 16;
        
        for (let i = 0; i < numberOfRuns && runOffset + 16 <= buffer.byteLength; i++) {
            runs.push({
                basePage: view.getBigUint64(runOffset, true),
                pageCount: view.getBigUint64(runOffset + 8, true),
            });
            runOffset += 16;
        }
        
        header.physicalMemoryDescriptor = {
            numberOfRuns,
            numberOfPages,
            runs,
        };
    } catch (e) {
        console.error('Failed to parse physical memory descriptor:', e);
    }
    
    // Parse context record
    try {
        const is64Bit = header.machineImageType === 0x8664; // IMAGE_FILE_MACHINE_AMD64
        const context = parseContext(buffer, DUMP_HEADER64_OFFSETS.ContextRecord, is64Bit);
        if (context) {
            header.context = context;
        }
    } catch (e) {
        console.error('Failed to parse context record:', e);
    }
    
    // Try to parse KdDebuggerDataBlock if it's mapped
    if (header.kdDebuggerDataBlock !== 0n) {
        // In a full dump, we'd need to translate this virtual address to physical
        // For now, we'll check if it's at a known offset
        try {
            const kdDbgOffset = 0x1000; // Common offset in some dumps
            if (buffer.byteLength > kdDbgOffset + 0x100) {
                const ownerTag = view.getUint32(kdDbgOffset + KDDEBUGGER_DATA64_OFFSETS.OwnerTag, true);
                if (ownerTag === 0x4742444B) { // 'KDBG'
                    header.kernelBase = view.getBigUint64(kdDbgOffset + KDDEBUGGER_DATA64_OFFSETS.KernBase, true);
                }
            }
        } catch (e) {
            // KdDebuggerDataBlock not accessible
        }
    }
    
    return header;
}

/**
 * Parse module list from kernel dump
 */
export interface KernelModule {
    dllBase: bigint;
    entryPoint: bigint;
    sizeOfImage: number;
    fullDllName: string;
    baseDllName: string;
    flags: number;
    loadCount: number;
    checkSum: number;
    timeDateStamp: number;
}

/**
 * Parse KLDR_DATA_TABLE_ENTRY structures from module list
 * Note: This requires virtual to physical address translation in real implementation
 */
export function parseKernelModuleList(
    buffer: ArrayBuffer, 
    psLoadedModuleList: bigint,
    directoryTableBase: bigint
): KernelModule[] {
    // In a real implementation, we would:
    // 1. Translate psLoadedModuleList virtual address to physical
    // 2. Walk the LIST_ENTRY linked list
    // 3. Parse each KLDR_DATA_TABLE_ENTRY structure
    // 4. Extract module information
    
    // For now, return empty array as this requires full memory translation
    console.log('Module list parsing requires virtual to physical translation');
    return [];
}

/**
 * Get processor architecture name from machine type
 */
export function getMachineTypeName(machineType: number): string {
    const machineTypes: Record<number, string> = {
        0x014c: 'x86',
        0x0200: 'IA64',
        0x8664: 'AMD64',
        0x01c0: 'ARM',
        0x01c4: 'ARMv7',
        0xAA64: 'ARM64',
        0x0EBC: 'EFI',
    };
    
    return machineTypes[machineType] || `Unknown (0x${machineType.toString(16)})`;
}

/**
 * Validate kernel dump header
 */
export function validateKernelDumpHeader(header: KernelDumpHeader): {
    valid: boolean;
    errors: string[];
} {
    const errors: string[] = [];
    
    // Validate version
    if (header.majorVersion < 1 || header.majorVersion > 100) {
        errors.push(`Invalid major version: ${header.majorVersion}`);
    }
    
    // Validate machine type
    const validMachineTypes = [0x014c, 0x0200, 0x8664, 0x01c0, 0x01c4, 0xAA64];
    if (!validMachineTypes.includes(header.machineImageType)) {
        errors.push(`Unknown machine type: 0x${header.machineImageType.toString(16)}`);
    }
    
    // Validate processor count
    if (header.numberOfProcessors < 1 || header.numberOfProcessors > 1024) {
        errors.push(`Invalid processor count: ${header.numberOfProcessors}`);
    }
    
    // Validate CR3 (directory table base)
    if (header.directoryTableBase === 0n) {
        errors.push('Directory table base (CR3) is zero');
    }
    
    // Validate bug check code if present
    if (header.bugCheckCode !== 0 && header.bugCheckCode > 0x1000) {
        errors.push(`Suspicious bug check code: 0x${header.bugCheckCode.toString(16)}`);
    }
    
    // Validate kernel addresses
    if (header.psLoadedModuleList !== 0n && header.psLoadedModuleList < 0xFFFF800000000000n) {
        errors.push('PsLoadedModuleList address not in kernel space');
    }
    
    return {
        valid: errors.length === 0,
        errors,
    };
}

/**
 * Format kernel dump header for display
 */
export function formatKernelDumpHeader(header: KernelDumpHeader): string {
    const lines: string[] = [];
    
    lines.push('=== Kernel Dump Header ===');
    lines.push(`Signature: ${header.signature}`);
    lines.push(`Version: ${header.majorVersion}.${header.minorVersion}`);
    lines.push(`Architecture: ${getMachineTypeName(header.machineImageType)}`);
    lines.push(`Processors: ${header.numberOfProcessors}`);
    lines.push('');
    
    if (header.bugCheckCode !== 0) {
        lines.push('Bug Check Information:');
        lines.push(`  Code: 0x${header.bugCheckCode.toString(16).padStart(8, '0')}`);
        lines.push(`  Parameter 1: 0x${header.bugCheckParameters[0].toString(16).padStart(16, '0')}`);
        lines.push(`  Parameter 2: 0x${header.bugCheckParameters[1].toString(16).padStart(16, '0')}`);
        lines.push(`  Parameter 3: 0x${header.bugCheckParameters[2].toString(16).padStart(16, '0')}`);
        lines.push(`  Parameter 4: 0x${header.bugCheckParameters[3].toString(16).padStart(16, '0')}`);
        lines.push('');
    }
    
    lines.push('System Information:');
    lines.push(`  Directory Table Base: 0x${header.directoryTableBase.toString(16).padStart(16, '0')}`);
    lines.push(`  PFN Database: 0x${header.pfnDatabase.toString(16).padStart(16, '0')}`);
    lines.push(`  Module List: 0x${header.psLoadedModuleList.toString(16).padStart(16, '0')}`);
    lines.push(`  Process List: 0x${header.psActiveProcessHead.toString(16).padStart(16, '0')}`);
    
    if (header.kernelBase) {
        lines.push(`  Kernel Base: 0x${header.kernelBase.toString(16).padStart(16, '0')}`);
    }
    
    if (header.physicalMemoryDescriptor) {
        lines.push('');
        lines.push('Physical Memory:');
        lines.push(`  Total Pages: ${header.physicalMemoryDescriptor.numberOfPages} (${(header.physicalMemoryDescriptor.numberOfPages * 4096n / 1024n / 1024n)} MB)`);
        lines.push(`  Memory Runs: ${header.physicalMemoryDescriptor.numberOfRuns}`);
        
        // Show first few memory runs
        const maxRuns = Math.min(5, header.physicalMemoryDescriptor.runs.length);
        for (let i = 0; i < maxRuns; i++) {
            const run = header.physicalMemoryDescriptor.runs[i];
            const startAddr = run.basePage * 4096n;
            const size = run.pageCount * 4096n / 1024n / 1024n;
            lines.push(`    Run ${i + 1}: 0x${startAddr.toString(16).padStart(16, '0')} (${size} MB)`);
        }
        if (header.physicalMemoryDescriptor.numberOfRuns > maxRuns) {
            lines.push(`    ... and ${header.physicalMemoryDescriptor.numberOfRuns - maxRuns} more runs`);
        }
    }
    
    return lines.join('\n');
}