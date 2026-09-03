// Comprehensive minidump stream parsing for better accuracy
// Based on Windows SDK minidumpapiset.h

export enum MinidumpStreamType {
    UnusedStream = 0,
    ReservedStream0 = 1,
    ReservedStream1 = 2,
    ThreadListStream = 3,
    ModuleListStream = 4,
    MemoryListStream = 5,
    ExceptionStream = 6,
    SystemInfoStream = 7,
    ThreadExListStream = 8,
    Memory64ListStream = 9,
    CommentStreamA = 10,
    CommentStreamW = 11,
    HandleDataStream = 12,
    FunctionTableStream = 13,
    UnloadedModuleListStream = 14,
    MiscInfoStream = 15,
    MemoryInfoListStream = 16,
    ThreadInfoListStream = 17,
    HandleOperationListStream = 18,
    TokenStream = 19,
    JavaScriptDataStream = 20,
    SystemMemoryInfoStream = 21,
    ProcessVmCountersStream = 22,
    IptTraceStream = 23,
    ThreadNamesStream = 24,
}

export interface MinidumpStream {
    streamType: MinidumpStreamType;
    dataSize: number;
    rva: number;
}

export interface MinidumpSystemInfo {
    processorArchitecture: number;
    processorLevel: number;
    processorRevision: number;
    numberOfProcessors: number;
    productType: number;
    majorVersion: number;
    minorVersion: number;
    buildNumber: number;
    platformId: number;
    csdVersionRva: number;
    suiteMask: number;
    cpuInfo: {
        vendorId: string;
        versionInfo: number;
        featureInfo: number;
        amdExtendedFeatures: number;
    };
}

export interface MinidumpModule {
    baseAddress: bigint;
    size: number;
    checksum: number;
    timestamp: number;
    nameRva: number;
    name: string;
    versionInfo: {
        signature: number;
        strucVersion: number;
        fileVersionMS: number;
        fileVersionLS: number;
        productVersionMS: number;
        productVersionLS: number;
        fileFlagsMask: number;
        fileFlags: number;
        fileOS: number;
        fileType: number;
        fileSubtype: number;
        fileDateMS: number;
        fileDateLS: number;
    };
}

export interface MinidumpThread {
    threadId: number;
    suspendCount: number;
    priorityClass: number;
    priority: number;
    teb: bigint;
    stackStart: bigint;
    stackEnd: bigint;
    instructionPointer: bigint;
    stackPointer: bigint;
    framePointer: bigint;
}

export interface MinidumpException {
    exceptionCode: number;
    exceptionFlags: number;
    exceptionRecord: bigint;
    exceptionAddress: bigint;
    numberParameters: number;
    exceptionInformation: bigint[];
}

export class MinidumpParser {
    private view: DataView;
    private buffer: ArrayBuffer;
    private streams: Map<MinidumpStreamType, MinidumpStream> = new Map();
    
    constructor(buffer: ArrayBuffer) {
        this.buffer = buffer;
        this.view = new DataView(buffer);
        this.parseStreams();
    }
    
    private parseStreams(): void {
        // Check signature
        const signature = this.view.getUint32(0, true);
        if (signature !== 0x504D444D) { // 'MDMP'
            throw new Error('Not a valid minidump file');
        }
        
        const streamCount = this.view.getUint32(8, true);
        const streamDirRva = this.view.getUint32(12, true);
        
        // Parse stream directory
        for (let i = 0; i < streamCount; i++) {
            const offset = streamDirRva + (i * 12);
            if (offset + 12 > this.buffer.byteLength) break;
            
            const streamType = this.view.getUint32(offset, true) as MinidumpStreamType;
            const dataSize = this.view.getUint32(offset + 4, true);
            const rva = this.view.getUint32(offset + 8, true);
            
            this.streams.set(streamType, { streamType, dataSize, rva });
        }
    }
    
    public getSystemInfo(): MinidumpSystemInfo | null {
        const stream = this.streams.get(MinidumpStreamType.SystemInfoStream);
        if (!stream || stream.rva + 56 > this.buffer.byteLength) return null;
        
        const offset = stream.rva;
        return {
            processorArchitecture: this.view.getUint16(offset, true),
            processorLevel: this.view.getUint16(offset + 2, true),
            processorRevision: this.view.getUint16(offset + 4, true),
            numberOfProcessors: this.view.getUint8(offset + 6),
            productType: this.view.getUint8(offset + 7),
            majorVersion: this.view.getUint32(offset + 8, true),
            minorVersion: this.view.getUint32(offset + 12, true),
            buildNumber: this.view.getUint32(offset + 16, true),
            platformId: this.view.getUint32(offset + 20, true),
            csdVersionRva: this.view.getUint32(offset + 24, true),
            suiteMask: this.view.getUint16(offset + 28, true),
            cpuInfo: {
                vendorId: this.extractString(offset + 32, 12),
                versionInfo: this.view.getUint32(offset + 44, true),
                featureInfo: this.view.getUint32(offset + 48, true),
                amdExtendedFeatures: this.view.getUint32(offset + 52, true),
            }
        };
    }
    
    public getModules(): MinidumpModule[] {
        const stream = this.streams.get(MinidumpStreamType.ModuleListStream);
        if (!stream || stream.rva + 4 > this.buffer.byteLength) return [];
        
        const modules: MinidumpModule[] = [];
        const numberOfModules = this.view.getUint32(stream.rva, true);
        let offset = stream.rva + 4;
        
        for (let i = 0; i < numberOfModules && offset + 108 <= this.buffer.byteLength; i++) {
            const module: MinidumpModule = {
                baseAddress: this.view.getBigUint64(offset, true),
                size: this.view.getUint32(offset + 8, true),
                checksum: this.view.getUint32(offset + 12, true),
                timestamp: this.view.getUint32(offset + 16, true),
                nameRva: this.view.getUint32(offset + 20, true),
                name: '',
                versionInfo: {
                    signature: this.view.getUint32(offset + 24, true),
                    strucVersion: this.view.getUint32(offset + 28, true),
                    fileVersionMS: this.view.getUint32(offset + 32, true),
                    fileVersionLS: this.view.getUint32(offset + 36, true),
                    productVersionMS: this.view.getUint32(offset + 40, true),
                    productVersionLS: this.view.getUint32(offset + 44, true),
                    fileFlagsMask: this.view.getUint32(offset + 48, true),
                    fileFlags: this.view.getUint32(offset + 52, true),
                    fileOS: this.view.getUint32(offset + 56, true),
                    fileType: this.view.getUint32(offset + 60, true),
                    fileSubtype: this.view.getUint32(offset + 64, true),
                    fileDateMS: this.view.getUint32(offset + 68, true),
                    fileDateLS: this.view.getUint32(offset + 72, true),
                }
            };
            
            // Extract module name. MINIDUMP_MODULE.ModuleNameRva points at the
            // module's full path (e.g. C:\Windows\System32\ntoskrnl.exe); store
            // the bare filename so isLegitimateModuleName(), culprit matching
            // and driver-version lookups — which all compare bare names — work.
            if (module.nameRva && module.nameRva + 4 < this.buffer.byteLength) {
                const nameLength = this.view.getUint32(module.nameRva, true);
                const fullName = this.extractUnicodeString(module.nameRva + 4, nameLength);
                module.name = fullName.split(/[\\/]/).pop() ?? fullName;
            }
            
            modules.push(module);
            offset += 108;
        }
        
        return modules;
    }
    
    public getThreads(): MinidumpThread[] {
        const stream = this.streams.get(MinidumpStreamType.ThreadListStream);
        if (!stream || stream.rva + 4 > this.buffer.byteLength) return [];
        
        const threads: MinidumpThread[] = [];
        const numberOfThreads = this.view.getUint32(stream.rva, true);
        let offset = stream.rva + 4;
        
        for (let i = 0; i < numberOfThreads && offset + 48 <= this.buffer.byteLength; i++) {
            const thread: MinidumpThread = {
                threadId: this.view.getUint32(offset, true),
                suspendCount: this.view.getUint32(offset + 4, true),
                priorityClass: this.view.getUint32(offset + 8, true),
                priority: this.view.getUint32(offset + 12, true),
                teb: this.view.getBigUint64(offset + 16, true),
                stackStart: this.view.getBigUint64(offset + 24, true),
                stackEnd: this.view.getBigUint64(offset + 32, true),
                instructionPointer: 0n,
                stackPointer: 0n,
                framePointer: 0n,
            };
            
            // MINIDUMP_LOCATION_DESCRIPTOR stores DataSize first, then RVA.
            const contextSize = this.view.getUint32(offset + 40, true);
            const contextRva = this.view.getUint32(offset + 44, true);
            
            if (contextRva && contextSize >= 0x4D0 && contextRva + 0x4D0 <= this.buffer.byteLength) {
                // Extract key registers from CONTEXT structure (x64)
                thread.instructionPointer = this.view.getBigUint64(contextRva + 0xF8, true); // RIP
                thread.stackPointer = this.view.getBigUint64(contextRva + 0x98, true); // RSP
                thread.framePointer = this.view.getBigUint64(contextRva + 0xA0, true); // RBP
            }
            
            threads.push(thread);
            offset += 48;
        }
        
        return threads;
    }
    
    public getException(): MinidumpException | null {
        const stream = this.streams.get(MinidumpStreamType.ExceptionStream);
        if (!stream || stream.rva + 168 > this.buffer.byteLength) return null;
        
        // Skip ThreadId and alignment
        const exceptionOffset = stream.rva + 8;
        
        const exception: MinidumpException = {
            exceptionCode: this.view.getUint32(exceptionOffset, true),
            exceptionFlags: this.view.getUint32(exceptionOffset + 4, true),
            exceptionRecord: this.view.getBigUint64(exceptionOffset + 8, true),
            exceptionAddress: this.view.getBigUint64(exceptionOffset + 16, true),
            numberParameters: this.view.getUint32(exceptionOffset + 24, true),
            exceptionInformation: []
        };
        
        // Read exception information array (up to 15 parameters)
        const numParams = Math.min(exception.numberParameters, 15);
        for (let i = 0; i < numParams; i++) {
            exception.exceptionInformation.push(
                this.view.getBigUint64(exceptionOffset + 32 + (i * 8), true)
            );
        }
        
        return exception;
    }
    
    public getBugCheckInfo(): { code: number; parameters: bigint[] } | null {
        // Bug check data has no defined location inside a (user-mode) MDMP, so
        // the only legitimate evidence is the kernel-crash convention: an
        // exception stream whose code is 0x80000003 (BREAKPOINT), carrying the
        // bug check code in ExceptionInformation[0] and the parameters in
        // [1..4]. The old fixed-offset scans here read raw uint32s out of the
        // stream directory / stream payloads and returned stream sizes, RVAs
        // and directory types as a fabricated STOP code.
        const exception = this.getException();
        if (exception && exception.exceptionCode === 0x80000003) { // BREAKPOINT
            if (exception.exceptionInformation.length >= 5) {
                const code = Number(exception.exceptionInformation[0]);
                if (this.isPlausibleBugCheckCode(code)) {
                    return {
                        code,
                        parameters: exception.exceptionInformation.slice(1, 5)
                    };
                }
            }
        }

        return null;
    }

    // Bug check codes are small (KeBugCheck codes, 0x1..0x1FF) or
    // parameterized 0xC........ codes; anything else in the exception payload
    // is not crash evidence.
    private isPlausibleBugCheckCode(code: number): boolean {
        return (code > 0 && code <= 0x1FF) ||
               (code >= 0xC0000000 && code <= 0xC0FFFFFF);
    }
    
    private extractString(offset: number, maxLength: number): string {
        const bytes = new Uint8Array(this.buffer, offset, Math.min(maxLength, this.buffer.byteLength - offset));
        let str = '';
        for (let i = 0; i < bytes.length && bytes[i] !== 0; i++) {
            str += String.fromCharCode(bytes[i]);
        }
        return str;
    }
    
    private extractUnicodeString(offset: number, length: number): string {
        const bytes = new Uint8Array(this.buffer, offset, Math.min(length, this.buffer.byteLength - offset));
        const decoder = new TextDecoder('utf-16le');
        return decoder.decode(bytes).replace(/\0/g, '');
    }
    
    public getThreadStack(threadId: number): ArrayBuffer | null {
        // First find the thread
        const threads = this.getThreads();
        const thread = threads.find(t => t.threadId === threadId);
        if (!thread) return null;
        
        // Get memory list to find stack memory
        const memListStream = this.streams.get(MinidumpStreamType.MemoryListStream);
        const mem64ListStream = this.streams.get(MinidumpStreamType.Memory64ListStream);
        
        // Try Memory64ListStream first (more common in modern dumps)
        if (mem64ListStream && mem64ListStream.rva + 16 <= this.buffer.byteLength) {
            const numberOfMemoryRanges = this.view.getBigUint64(mem64ListStream.rva, true);
            let baseRva = this.view.getBigUint64(mem64ListStream.rva + 8, true);
            let descriptorOffset = mem64ListStream.rva + 16;
            
            for (let i = 0n; i < numberOfMemoryRanges; i++) {
                if (descriptorOffset + 16 > this.buffer.byteLength) break;
                
                const startAddress = this.view.getBigUint64(descriptorOffset, true);
                const dataSize = this.view.getBigUint64(descriptorOffset + 8, true);
                
                // Check if this memory range contains the thread's stack
                if (startAddress <= thread.stackPointer && thread.stackPointer < startAddress + dataSize) {
                    // Found the stack memory
                    const stackOffset = Number(thread.stackPointer - startAddress);
                    const stackSize = Math.min(Number(dataSize - BigInt(stackOffset)), 0x10000); // Limit to 64KB
                    
                    if (Number(baseRva) + stackOffset + stackSize <= this.buffer.byteLength) {
                        return this.buffer.slice(Number(baseRva) + stackOffset, Number(baseRva) + stackOffset + stackSize);
                    }
                }
                
                descriptorOffset += 16;
                baseRva += dataSize;
            }
        }
        
        // Try MemoryListStream as fallback
        if (memListStream && memListStream.rva + 4 <= this.buffer.byteLength) {
            const numberOfMemoryRanges = this.view.getUint32(memListStream.rva, true);
            let offset = memListStream.rva + 4;
            
            for (let i = 0; i < numberOfMemoryRanges; i++) {
                if (offset + 16 > this.buffer.byteLength) break;
                
                const startAddress = this.view.getBigUint64(offset, true);
                const memorySize = this.view.getUint32(offset + 8, true);
                const rva = this.view.getUint32(offset + 12, true);
                
                // Check if this memory range contains the thread's stack
                if (startAddress <= thread.stackPointer && thread.stackPointer < startAddress + BigInt(memorySize)) {
                    // Found the stack memory
                    const stackOffset = Number(thread.stackPointer - startAddress);
                    const stackSize = Math.min(memorySize - stackOffset, 0x10000); // Limit to 64KB
                    
                    if (rva + stackOffset + stackSize <= this.buffer.byteLength) {
                        return this.buffer.slice(rva + stackOffset, rva + stackOffset + stackSize);
                    }
                }
                
                offset += 16;
            }
        }
        
        return null;
    }
}
