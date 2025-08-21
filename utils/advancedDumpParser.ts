// Advanced dump parser with deep binary analysis capabilities
import {
    MINIDUMP_HEADER,
    DUMP_HEADER64,
    CONTEXT_AMD64,
    EXCEPTION_RECORD64,
    KLDR_DATA_TABLE_ENTRY,
    POOL_HEADER,
    POOL_TAGS,
    EXCEPTION_CODES,
    IRQL_LEVELS,
    WAIT_REASONS,
    IMAGE_DOS_HEADER,
    IMAGE_NT_HEADERS64,
    UNICODE_STRING,
    LIST_ENTRY,
    KTHREAD,
    KPRCB
} from './binaryStructures';

export class AdvancedDumpParser {
    private buffer: ArrayBuffer;
    private view: DataView;
    private is64Bit: boolean = true;
    private dumpType: 'MINIDUMP' | 'FULLDUMP' | 'KERNELDUMP' | 'UNKNOWN' = 'UNKNOWN';

    constructor(buffer: ArrayBuffer) {
        this.buffer = buffer;
        this.view = new DataView(buffer);
        this.detectDumpType();
    }

    private detectDumpType(): void {
        if (this.buffer.byteLength < 32) return;

        const sig1 = this.view.getUint32(0, true);
        
        if (sig1 === 0x504D444D) { // 'MDMP'
            this.dumpType = 'MINIDUMP';
        } else if (sig1 === 0x45474150) { // 'PAGE'
            const sig2 = this.view.getUint32(4, true);
            if (sig2 === 0x504D5544) { // 'DUMP'
                this.dumpType = this.buffer.byteLength > 1024 * 1024 * 1024 ? 'FULLDUMP' : 'KERNELDUMP';
            }
        }
    }

    public parseMinidumpHeader(): MINIDUMP_HEADER | null {
        if (this.dumpType !== 'MINIDUMP' || this.buffer.byteLength < 32) return null;

        return {
            signature: this.view.getUint32(0, true),
            version: this.view.getUint32(4, true),
            numberOfStreams: this.view.getUint32(8, true),
            streamDirectoryRva: this.view.getUint32(12, true),
            checksum: this.view.getUint32(16, true),
            timestamp: this.view.getUint32(20, true),
            flags: this.view.getBigUint64(24, true)
        };
    }

    public parseFullDumpHeader(): DUMP_HEADER64 | null {
        if ((this.dumpType !== 'FULLDUMP' && this.dumpType !== 'KERNELDUMP') || this.buffer.byteLength < 0x2000) {
            return null;
        }

        const header: Partial<DUMP_HEADER64> = {
            signature: this.readString(0, 8),
            validDump: this.readString(8, 4),
            majorVersion: this.view.getUint32(0x10, true),
            minorVersion: this.view.getUint32(0x14, true),
        };

        // Read bug check information
        const bugCheckOffset = 0x80;
        if (this.buffer.byteLength > bugCheckOffset + 40) {
            header.bugCheckCode = this.view.getUint32(bugCheckOffset, true);
            header.bugCheckParameter1 = this.readPointer(bugCheckOffset + 8);
            header.bugCheckParameter2 = this.readPointer(bugCheckOffset + 16);
            header.bugCheckParameter3 = this.readPointer(bugCheckOffset + 24);
            header.bugCheckParameter4 = this.readPointer(bugCheckOffset + 32);
        }

        // Read system information
        if (this.buffer.byteLength > 0x90) {
            header.machineImageType = this.view.getUint16(0x32, true);
            header.numberOfProcessors = this.view.getUint32(0x38, true);
            header.pfnDatabase = this.readPointer(0x90);
            header.psLoadedModuleList = this.readPointer(0x98);
        }

        // Read CONTEXT record location
        const contextOffset = 0x1000; // Usually at page boundary
        if (this.buffer.byteLength > contextOffset + 0x500) {
            header.contextRecord = new Uint8Array(this.buffer, contextOffset, 0x500);
        }

        return header as DUMP_HEADER64;
    }

    public parseContext(contextData: Uint8Array): CONTEXT_AMD64 | null {
        if (contextData.length < 0x4D0) return null; // Minimum CONTEXT size

        const view = new DataView(contextData.buffer, contextData.byteOffset, contextData.byteLength);
        
        const context: CONTEXT_AMD64 = {
            p1Home: view.getBigUint64(0x00, true),
            p2Home: view.getBigUint64(0x08, true),
            p3Home: view.getBigUint64(0x10, true),
            p4Home: view.getBigUint64(0x18, true),
            p5Home: view.getBigUint64(0x20, true),
            p6Home: view.getBigUint64(0x28, true),
            contextFlags: view.getUint32(0x30, true),
            mxCsr: view.getUint32(0x34, true),
            segCs: view.getUint16(0x38, true),
            segDs: view.getUint16(0x3A, true),
            segEs: view.getUint16(0x3C, true),
            segFs: view.getUint16(0x3E, true),
            segGs: view.getUint16(0x40, true),
            segSs: view.getUint16(0x42, true),
            eFlags: view.getUint32(0x44, true),
            dr0: view.getBigUint64(0x48, true),
            dr1: view.getBigUint64(0x50, true),
            dr2: view.getBigUint64(0x58, true),
            dr3: view.getBigUint64(0x60, true),
            dr6: view.getBigUint64(0x68, true),
            dr7: view.getBigUint64(0x70, true),
            rax: view.getBigUint64(0x78, true),
            rcx: view.getBigUint64(0x80, true),
            rdx: view.getBigUint64(0x88, true),
            rbx: view.getBigUint64(0x90, true),
            rsp: view.getBigUint64(0x98, true),
            rbp: view.getBigUint64(0xA0, true),
            rsi: view.getBigUint64(0xA8, true),
            rdi: view.getBigUint64(0xB0, true),
            r8: view.getBigUint64(0xB8, true),
            r9: view.getBigUint64(0xC0, true),
            r10: view.getBigUint64(0xC8, true),
            r11: view.getBigUint64(0xD0, true),
            r12: view.getBigUint64(0xD8, true),
            r13: view.getBigUint64(0xE0, true),
            r14: view.getBigUint64(0xE8, true),
            r15: view.getBigUint64(0xF0, true),
            rip: view.getBigUint64(0xF8, true),
        };

        return context;
    }

    public findAndParseAllExceptions(): EXCEPTION_RECORD64[] {
        const exceptions: EXCEPTION_RECORD64[] = [];
        const searchLimit = Math.min(this.buffer.byteLength, 0x100000); // Search first 1MB

        for (let i = 0; i < searchLimit - 32; i += 8) {
            const code = this.view.getUint32(i, true);
            
            if (EXCEPTION_CODES[code]) {
                try {
                    const exception: EXCEPTION_RECORD64 = {
                        exceptionCode: code,
                        exceptionFlags: this.view.getUint32(i + 4, true),
                        exceptionRecord: this.readPointer(i + 8),
                        exceptionAddress: this.readPointer(i + 16),
                        numberOfParameters: this.view.getUint32(i + 24, true),
                        exceptionInformation: []
                    };

                    // Read exception parameters
                    const paramCount = Math.min(exception.numberOfParameters, 15);
                    for (let j = 0; j < paramCount; j++) {
                        exception.exceptionInformation.push(
                            this.readPointer(i + 32 + (j * 8))
                        );
                    }

                    // Validate it looks like a real exception
                    if (this.isValidKernelAddress(exception.exceptionAddress)) {
                        exceptions.push(exception);
                    }
                } catch (e) {
                    continue;
                }
            }
        }

        return exceptions;
    }

    public analyzeMemoryCorruption(): {
        corruptionType: string;
        details: string;
        affectedRegions: Array<{ address: bigint; size: number; pattern: string }>;
    }[] {
        const corruptions: any[] = [];
        const patterns = [
            { bytes: [0xDE, 0xAD, 0xBE, 0xEF], name: 'Use-after-free marker' },
            { bytes: [0xBA, 0xD0, 0xBA, 0xD0], name: 'Bad pool marker' },
            { bytes: [0xFE, 0xEE, 0xFE, 0xEE], name: 'Freed memory pattern' },
            { bytes: [0xCC, 0xCC, 0xCC, 0xCC], name: 'Uninitialized stack' },
            { bytes: [0xCD, 0xCD, 0xCD, 0xCD], name: 'Uninitialized heap' },
            { bytes: [0xDD, 0xDD, 0xDD, 0xDD], name: 'Freed heap memory' },
            { bytes: [0xFD, 0xFD, 0xFD, 0xFD], name: 'Guard bytes (overflow detection)' },
        ];

        // Scan for corruption patterns
        const scanLimit = Math.min(this.buffer.byteLength, 0x1000000); // 16MB limit
        const uint8View = new Uint8Array(this.buffer);

        for (const pattern of patterns) {
            for (let i = 0; i < scanLimit - pattern.bytes.length * 16; i += 0x1000) {
                let consecutiveCount = 0;
                
                for (let j = 0; j < 16; j++) {
                    const match = pattern.bytes.every((byte, idx) => 
                        uint8View[i + j * pattern.bytes.length + idx] === byte
                    );
                    
                    if (match) consecutiveCount++;
                    else break;
                }

                if (consecutiveCount >= 4) {
                    corruptions.push({
                        corruptionType: pattern.name,
                        details: `Found ${consecutiveCount} consecutive instances`,
                        affectedRegions: [{
                            address: BigInt(i),
                            size: consecutiveCount * pattern.bytes.length,
                            pattern: pattern.bytes.map(b => b.toString(16).padStart(2, '0')).join(' ')
                        }]
                    });
                }
            }
        }

        return corruptions;
    }

    public parsePoolHeaders(): { 
        address: number; 
        header: POOL_HEADER; 
        tagString: string;
        corruption: boolean;
    }[] {
        const poolHeaders: any[] = [];
        const searchLimit = Math.min(this.buffer.byteLength, 0x100000);

        for (let i = 0; i < searchLimit - 16; i += 8) {
            try {
                // Pool headers are 16 bytes on x64
                const poolTag = this.view.getUint32(i + 4, true);
                
                // Check if this looks like a valid pool tag
                if (this.isValidPoolTag(poolTag)) {
                    const header: POOL_HEADER = {
                        previousSize: this.view.getUint8(i) & 0xFF,
                        poolIndex: this.view.getUint8(i + 1),
                        blockSize: this.view.getUint8(i + 2) & 0xFF,
                        poolType: this.view.getUint8(i + 3),
                        poolTag: poolTag,
                        processBilled: BigInt(0) // Would need EPROCESS pointer
                    };

                    const tagString = this.poolTagToString(poolTag);
                    const corruption = this.isPoolHeaderCorrupted(header, i);

                    poolHeaders.push({
                        address: i,
                        header,
                        tagString,
                        corruption
                    });
                }
            } catch (e) {
                continue;
            }
        }

        return poolHeaders;
    }

    public extractDriverSignatures(): {
        name: string;
        base: bigint;
        size: number;
        timestamp: Date | null;
        checksum: number;
        version: string | null;
        signed: boolean;
    }[] {
        const drivers: any[] = [];
        const processedOffsets = new Set<number>();

        // Search for PE headers in memory
        for (let i = 0; i < Math.min(this.buffer.byteLength - 0x1000, 0x1000000); i += 0x1000) {
            if (processedOffsets.has(i)) continue;

            try {
                // Check for MZ signature
                if (this.view.getUint16(i, true) !== 0x5A4D) continue;

                const dosHeader = this.parseDosHeader(i);
                if (!dosHeader || dosHeader.e_lfanew > 0x1000) continue;

                const peOffset = i + dosHeader.e_lfanew;
                if (peOffset + 264 > this.buffer.byteLength) continue;

                // Check for PE signature
                if (this.view.getUint32(peOffset, true) !== 0x00004550) continue;

                const ntHeaders = this.parseNtHeaders(peOffset);
                if (!ntHeaders) continue;

                // Extract driver info
                const driverInfo = {
                    name: this.findDriverName(i, ntHeaders.optionalHeader.sizeOfImage),
                    base: BigInt(i),
                    size: ntHeaders.optionalHeader.sizeOfImage,
                    timestamp: new Date(ntHeaders.fileHeader.timeDateStamp * 1000),
                    checksum: ntHeaders.optionalHeader.checkSum,
                    version: this.extractVersionInfo(i, ntHeaders),
                    signed: this.hasValidSignature(i, ntHeaders)
                };

                drivers.push(driverInfo);
                processedOffsets.add(i);

                // Skip to next potential driver location
                i += ntHeaders.optionalHeader.sizeOfImage - 0x1000;
            } catch (e) {
                continue;
            }
        }

        return drivers;
    }

    public walkKernelStack(context: CONTEXT_AMD64): {
        frame: number;
        rip: bigint;
        rsp: bigint;
        functionName: string | null;
        module: string | null;
        offset: bigint;
    }[] {
        const stack: any[] = [];
        let currentRsp = context.rsp;
        let currentRbp = context.rbp;
        let frameCount = 0;
        const maxFrames = 64;

        // Add current instruction pointer as first frame
        const ripInfo = this.resolveAddress(context.rip);
        stack.push({
            frame: frameCount++,
            rip: context.rip,
            rsp: currentRsp,
            functionName: ripInfo.function,
            module: ripInfo.module,
            offset: ripInfo.offset
        });

        // Walk the stack
        while (frameCount < maxFrames && this.isValidKernelAddress(currentRbp)) {
            try {
                const rbpOffset = this.virtualToPhysical(currentRbp);
                if (rbpOffset < 0 || rbpOffset + 16 > this.buffer.byteLength) break;

                const savedRbp = this.readPointer(rbpOffset);
                const returnAddress = this.readPointer(rbpOffset + 8);

                if (!this.isValidKernelAddress(returnAddress)) break;

                const addrInfo = this.resolveAddress(returnAddress);
                stack.push({
                    frame: frameCount++,
                    rip: returnAddress,
                    rsp: currentRbp + BigInt(16),
                    functionName: addrInfo.function,
                    module: addrInfo.module,
                    offset: addrInfo.offset
                });

                currentRbp = savedRbp;
            } catch (e) {
                break;
            }
        }

        return stack;
    }

    public analyzeIrqlTransitions(): {
        previousIrql: number;
        newIrql: number;
        location: bigint;
        violation: boolean;
        details: string;
    }[] {
        const transitions: any[] = [];
        
        // Search for IRQL transition patterns
        const patterns = [
            { bytes: [0x0F, 0x20, 0xC0], name: 'mov rax, cr8' }, // Read CR8 (IRQL)
            { bytes: [0x0F, 0x22, 0xC0], name: 'mov cr8, rax' }, // Write CR8 (IRQL)
            { bytes: [0x44, 0x0F, 0x20, 0xC0], name: 'mov rax, cr8' }, // REX prefix
            { bytes: [0x44, 0x0F, 0x22, 0xC0], name: 'mov cr8, rax' }, // REX prefix
        ];

        const uint8View = new Uint8Array(this.buffer);
        const searchLimit = Math.min(this.buffer.byteLength, 0x100000);

        for (let i = 0; i < searchLimit - 16; i++) {
            for (const pattern of patterns) {
                const match = pattern.bytes.every((byte, idx) => 
                    uint8View[i + idx] === byte
                );

                if (match) {
                    // Try to determine IRQL values from surrounding code
                    const irqlInfo = this.extractIrqlInfo(i);
                    if (irqlInfo) {
                        transitions.push({
                            previousIrql: irqlInfo.previous,
                            newIrql: irqlInfo.new,
                            location: BigInt(i),
                            violation: this.isIrqlViolation(irqlInfo.previous, irqlInfo.new),
                            details: `${IRQL_LEVELS[irqlInfo.previous] || irqlInfo.previous} -> ${IRQL_LEVELS[irqlInfo.new] || irqlInfo.new}`
                        });
                    }
                }
            }
        }

        return transitions;
    }

    // Helper methods
    private readString(offset: number, length: number): string {
        const bytes = new Uint8Array(this.buffer, offset, length);
        let str = '';
        for (let i = 0; i < length && bytes[i] !== 0; i++) {
            str += String.fromCharCode(bytes[i]);
        }
        return str;
    }

    private readPointer(offset: number): bigint {
        if (this.is64Bit) {
            return this.view.getBigUint64(offset, true);
        } else {
            return BigInt(this.view.getUint32(offset, true));
        }
    }

    private isValidKernelAddress(address: bigint): boolean {
        // x64 kernel addresses typically start with 0xFFFF
        if (this.is64Bit) {
            return address >= 0xFFFF000000000000n && address < 0xFFFFFFFFFFFFFFFFn;
        } else {
            // x86 kernel addresses typically >= 0x80000000
            return address >= 0x80000000n && address <= 0xFFFFFFFFn;
        }
    }

    private isValidPoolTag(tag: number): boolean {
        // Pool tags are typically 4 ASCII characters
        const bytes = [
            (tag >> 0) & 0xFF,
            (tag >> 8) & 0xFF,
            (tag >> 16) & 0xFF,
            (tag >> 24) & 0xFF
        ];

        return bytes.every(b => (b >= 0x20 && b <= 0x7E) || b === 0);
    }

    private poolTagToString(tag: number): string {
        const knownTag = POOL_TAGS[tag];
        if (knownTag) return knownTag;

        const bytes = [
            (tag >> 0) & 0xFF,
            (tag >> 8) & 0xFF,
            (tag >> 16) & 0xFF,
            (tag >> 24) & 0xFF
        ];

        return bytes.map(b => b >= 0x20 && b <= 0x7E ? String.fromCharCode(b) : '.').join('');
    }

    private isPoolHeaderCorrupted(header: POOL_HEADER, offset: number): boolean {
        // Check for common corruption patterns
        if (header.previousSize > 0xFF || header.blockSize > 0xFF) return true;
        if (header.poolType > 0x7) return true; // Invalid pool type
        if (header.previousSize === 0 && offset !== 0) return true; // First block should have prev size 0
        
        return false;
    }

    private parseDosHeader(offset: number): IMAGE_DOS_HEADER | null {
        if (offset + 64 > this.buffer.byteLength) return null;

        return {
            e_magic: this.view.getUint16(offset, true),
            e_cblp: this.view.getUint16(offset + 2, true),
            e_cp: this.view.getUint16(offset + 4, true),
            e_crlc: this.view.getUint16(offset + 6, true),
            e_cparhdr: this.view.getUint16(offset + 8, true),
            e_minalloc: this.view.getUint16(offset + 10, true),
            e_maxalloc: this.view.getUint16(offset + 12, true),
            e_ss: this.view.getUint16(offset + 14, true),
            e_sp: this.view.getUint16(offset + 16, true),
            e_csum: this.view.getUint16(offset + 18, true),
            e_ip: this.view.getUint16(offset + 20, true),
            e_cs: this.view.getUint16(offset + 22, true),
            e_lfarlc: this.view.getUint16(offset + 24, true),
            e_ovno: this.view.getUint16(offset + 26, true),
            e_res: Array.from({ length: 4 }, (_, i) => this.view.getUint16(offset + 28 + i * 2, true)),
            e_oemid: this.view.getUint16(offset + 36, true),
            e_oeminfo: this.view.getUint16(offset + 38, true),
            e_res2: Array.from({ length: 10 }, (_, i) => this.view.getUint16(offset + 40 + i * 2, true)),
            e_lfanew: this.view.getInt32(offset + 60, true)
        };
    }

    private parseNtHeaders(offset: number): IMAGE_NT_HEADERS64 | null {
        if (offset + 264 > this.buffer.byteLength) return null;

        const fileHeader = {
            machine: this.view.getUint16(offset + 4, true),
            numberOfSections: this.view.getUint16(offset + 6, true),
            timeDateStamp: this.view.getUint32(offset + 8, true),
            pointerToSymbolTable: this.view.getUint32(offset + 12, true),
            numberOfSymbols: this.view.getUint32(offset + 16, true),
            sizeOfOptionalHeader: this.view.getUint16(offset + 20, true),
            characteristics: this.view.getUint16(offset + 22, true)
        };

        const optHeader = {
            magic: this.view.getUint16(offset + 24, true),
            majorLinkerVersion: this.view.getUint8(offset + 26),
            minorLinkerVersion: this.view.getUint8(offset + 27),
            sizeOfCode: this.view.getUint32(offset + 28, true),
            sizeOfInitializedData: this.view.getUint32(offset + 32, true),
            sizeOfUninitializedData: this.view.getUint32(offset + 36, true),
            addressOfEntryPoint: this.view.getUint32(offset + 40, true),
            baseOfCode: this.view.getUint32(offset + 44, true),
            imageBase: this.view.getBigUint64(offset + 48, true),
            sectionAlignment: this.view.getUint32(offset + 56, true),
            fileAlignment: this.view.getUint32(offset + 60, true),
            majorOperatingSystemVersion: this.view.getUint16(offset + 64, true),
            minorOperatingSystemVersion: this.view.getUint16(offset + 66, true),
            majorImageVersion: this.view.getUint16(offset + 68, true),
            minorImageVersion: this.view.getUint16(offset + 70, true),
            majorSubsystemVersion: this.view.getUint16(offset + 72, true),
            minorSubsystemVersion: this.view.getUint16(offset + 74, true),
            win32VersionValue: this.view.getUint32(offset + 76, true),
            sizeOfImage: this.view.getUint32(offset + 80, true),
            sizeOfHeaders: this.view.getUint32(offset + 84, true),
            checkSum: this.view.getUint32(offset + 88, true),
            subsystem: this.view.getUint16(offset + 92, true),
            dllCharacteristics: this.view.getUint16(offset + 94, true),
            sizeOfStackReserve: this.view.getBigUint64(offset + 96, true),
            sizeOfStackCommit: this.view.getBigUint64(offset + 104, true),
            sizeOfHeapReserve: this.view.getBigUint64(offset + 112, true),
            sizeOfHeapCommit: this.view.getBigUint64(offset + 120, true),
            loaderFlags: this.view.getUint32(offset + 128, true),
            numberOfRvaAndSizes: this.view.getUint32(offset + 132, true),
            dataDirectory: []
        };

        return {
            signature: this.view.getUint32(offset, true),
            fileHeader,
            optionalHeader: optHeader
        };
    }

    private findDriverName(baseOffset: number, imageSize: number): string {
        // Search for driver name in various locations
        const searchEnd = Math.min(baseOffset + imageSize, this.buffer.byteLength);
        const uint8View = new Uint8Array(this.buffer);
        
        // Common patterns for driver names
        const patterns = ['.sys', '.SYS', 'Driver', 'DRIVER'];
        
        for (let i = baseOffset; i < searchEnd - 260; i++) {
            for (const pattern of patterns) {
                const patternBytes = new TextEncoder().encode(pattern);
                let found = true;
                
                for (let j = 0; j < patternBytes.length; j++) {
                    if (uint8View[i + j] !== patternBytes[j]) {
                        found = false;
                        break;
                    }
                }
                
                if (found) {
                    // Extract the full name
                    let start = i;
                    while (start > baseOffset && uint8View[start - 1] >= 0x20 && uint8View[start - 1] <= 0x7E) {
                        start--;
                    }
                    
                    let end = i + pattern.length;
                    while (end < searchEnd && uint8View[end] >= 0x20 && uint8View[end] <= 0x7E) {
                        end++;
                    }
                    
                    const name = new TextDecoder('ascii', { fatal: false }).decode(
                        uint8View.slice(start, end)
                    );
                    
                    if (name.length > 3 && name.length < 260) {
                        return name;
                    }
                }
            }
        }
        
        return 'Unknown';
    }

    private extractVersionInfo(baseOffset: number, ntHeaders: IMAGE_NT_HEADERS64): string | null {
        // This would require parsing the resource section
        // For now, return null
        return null;
    }

    private hasValidSignature(baseOffset: number, ntHeaders: IMAGE_NT_HEADERS64): boolean {
        // Check for certificate table in data directory
        if (ntHeaders.optionalHeader.numberOfRvaAndSizes > 4) {
            // Certificate table is at index 4
            // Would need to parse and validate
            return false;
        }
        return false;
    }

    private virtualToPhysical(virtualAddress: bigint): number {
        // Simplified - would need page tables for accurate translation
        // For now, just use lower 32 bits as offset
        return Number(virtualAddress & 0xFFFFFFFFn) % this.buffer.byteLength;
    }

    private resolveAddress(address: bigint): { module: string | null; function: string | null; offset: bigint } {
        // Search for nearby strings that might be function names
        const searchOffset = this.virtualToPhysical(address);
        const searchRange = 0x1000; // 4KB range
        
        let module: string | null = null;
        let functionName: string | null = null;
        let offset = BigInt(0);
        
        // Search backwards for module/function names
        for (let i = searchOffset; i > Math.max(0, searchOffset - searchRange); i--) {
            const str = this.extractAsciiString(i, 256);
            if (str && str.length > 3) {
                if (str.endsWith('.sys') || str.endsWith('.dll')) {
                    module = str;
                } else if (str.match(/^[A-Za-z_][A-Za-z0-9_]*$/)) {
                    functionName = str;
                    offset = address - BigInt(i);
                    break;
                }
            }
        }
        
        return { module, function: functionName, offset };
    }

    private extractAsciiString(offset: number, maxLength: number): string | null {
        const uint8View = new Uint8Array(this.buffer);
        let str = '';
        
        for (let i = offset; i < Math.min(offset + maxLength, this.buffer.byteLength); i++) {
            const byte = uint8View[i];
            if (byte >= 0x20 && byte <= 0x7E) {
                str += String.fromCharCode(byte);
            } else if (byte === 0 && str.length > 0) {
                return str;
            } else {
                break;
            }
        }
        
        return str.length > 0 ? str : null;
    }

    private extractIrqlInfo(offset: number): { previous: number; new: number } | null {
        // Look for MOV instructions that set IRQL values
        const uint8View = new Uint8Array(this.buffer);
        
        // Check for immediate value moves before/after CR8 access
        for (let i = Math.max(0, offset - 16); i < Math.min(offset + 16, this.buffer.byteLength - 5); i++) {
            // MOV RAX, imm8: 48 C7 C0 XX
            if (uint8View[i] === 0x48 && uint8View[i + 1] === 0xC7 && uint8View[i + 2] === 0xC0) {
                const irqlValue = uint8View[i + 3];
                if (irqlValue <= 15) {
                    return { previous: 0, new: irqlValue }; // Simplified
                }
            }
        }
        
        return null;
    }

    private isIrqlViolation(previousIrql: number, newIrql: number): boolean {
        // Check for common IRQL violations
        if (previousIrql >= 2 && newIrql < previousIrql) {
            // Lowering IRQL below DISPATCH_LEVEL while holding spinlock
            return true;
        }
        
        if (previousIrql === 0 && newIrql > 2) {
            // Raising directly from PASSIVE to above DISPATCH
            return true;
        }
        
        return false;
    }

    public generateDetailedReport(): string {
        const report: string[] = ['=== Advanced Dump Analysis Report ===\n'];

        // Dump type and basic info
        report.push(`Dump Type: ${this.dumpType}`);
        report.push(`File Size: ${this.buffer.byteLength} bytes`);
        report.push(`Architecture: ${this.is64Bit ? 'x64' : 'x86'}\n`);

        // Parse headers based on type
        if (this.dumpType === 'MINIDUMP') {
            const header = this.parseMinidumpHeader();
            if (header) {
                report.push('Minidump Information:');
                report.push(`  Version: ${header.version}`);
                report.push(`  Streams: ${header.numberOfStreams}`);
                report.push(`  Timestamp: ${new Date(header.timestamp * 1000).toISOString()}\n`);
            }
        } else {
            const header = this.parseFullDumpHeader();
            if (header) {
                report.push('Full/Kernel Dump Information:');
                report.push(`  Version: ${header.majorVersion}.${header.minorVersion}`);
                if (header.bugCheckCode) {
                    const bugCheckName = Object.entries(require('./dumpParser').BUG_CHECK_CODES)
                        .find(([code]) => parseInt(code) === header.bugCheckCode)?.[1] || 'UNKNOWN';
                    report.push(`  Bug Check: 0x${header.bugCheckCode.toString(16).padStart(8, '0')} (${bugCheckName})`);
                    report.push(`  Parameter 1: 0x${header.bugCheckParameter1.toString(16)}`);
                    report.push(`  Parameter 2: 0x${header.bugCheckParameter2.toString(16)}`);
                    report.push(`  Parameter 3: 0x${header.bugCheckParameter3.toString(16)}`);
                    report.push(`  Parameter 4: 0x${header.bugCheckParameter4.toString(16)}\n`);
                }
            }
        }

        // Exception analysis
        const exceptions = this.findAndParseAllExceptions();
        if (exceptions.length > 0) {
            report.push(`Found ${exceptions.length} exception(s):`);
            exceptions.forEach((exc, idx) => {
                const excName = EXCEPTION_CODES[exc.exceptionCode] || 'UNKNOWN';
                report.push(`  ${idx + 1}. ${excName} (0x${exc.exceptionCode.toString(16).padStart(8, '0')})`);
                report.push(`     Address: 0x${exc.exceptionAddress.toString(16)}`);
                if (exc.exceptionCode === 0xC0000005) { // ACCESS_VIOLATION
                    report.push(`     Access Type: ${exc.exceptionInformation[0] === 0n ? 'Read' : 'Write'}`);
                    report.push(`     Target Address: 0x${exc.exceptionInformation[1]?.toString(16) || '0'}`);
                }
            });
            report.push('');
        }

        // Memory corruption analysis
        const corruptions = this.analyzeMemoryCorruption();
        if (corruptions.length > 0) {
            report.push(`Memory Corruption Detected (${corruptions.length} pattern(s)):`);
            corruptions.forEach(corruption => {
                report.push(`  Type: ${corruption.corruptionType}`);
                report.push(`  Details: ${corruption.details}`);
                corruption.affectedRegions.forEach(region => {
                    report.push(`    Address: 0x${region.address.toString(16)}, Size: ${region.size} bytes`);
                });
            });
            report.push('');
        }

        // Driver analysis
        const drivers = this.extractDriverSignatures();
        if (drivers.length > 0) {
            report.push(`Loaded Drivers (${drivers.length} found):`);
            drivers.slice(0, 20).forEach(driver => {
                report.push(`  ${driver.name}`);
                report.push(`    Base: 0x${driver.base.toString(16)}`);
                report.push(`    Size: ${driver.size} bytes`);
                report.push(`    Timestamp: ${driver.timestamp?.toISOString() || 'Unknown'}`);
                report.push(`    Signed: ${driver.signed ? 'Yes' : 'No'}`);
            });
            report.push('');
        }

        // Pool analysis
        const poolHeaders = this.parsePoolHeaders();
        const corruptedPools = poolHeaders.filter(p => p.corruption);
        if (corruptedPools.length > 0) {
            report.push(`Pool Corruption Detected (${corruptedPools.length} headers):`);
            corruptedPools.slice(0, 10).forEach(pool => {
                report.push(`  Address: 0x${pool.address.toString(16)}`);
                report.push(`  Tag: ${pool.tagString} (0x${pool.header.poolTag.toString(16)})`);
                report.push(`  Block Size: ${pool.header.blockSize}`);
            });
            report.push('');
        }

        // IRQL analysis
        const irqlTransitions = this.analyzeIrqlTransitions();
        const violations = irqlTransitions.filter(t => t.violation);
        if (violations.length > 0) {
            report.push(`IRQL Violations Detected (${violations.length}):`);
            violations.forEach(violation => {
                report.push(`  Location: 0x${violation.location.toString(16)}`);
                report.push(`  Transition: ${violation.details}`);
            });
            report.push('');
        }

        return report.join('\n');
    }
}