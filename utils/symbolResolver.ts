/**
 * Symbol resolution for Windows dump files
 * Extracts and resolves symbols from PDB information
 */

export interface SymbolInfo {
    moduleName: string;
    functionName: string;
    offset: number;
    sourceFile?: string;
    lineNumber?: number;
}

export interface PdbInfo {
    signature: string;
    age: number;
    guid: string;
    pdbFileName: string;
}

export interface ResolvedSymbol {
    address: number;
    module: string;
    symbol: string;
    offset: number;
    formatted: string; // e.g., "nt!KeBugCheckEx+0x123"
}

/**
 * Symbol cache to avoid re-resolving same addresses
 */
class SymbolCache {
    private cache = new Map<number, ResolvedSymbol>();
    private moduleRanges: Array<{
        start: number;
        end: number;
        module: string;
        pdbInfo?: PdbInfo;
    }> = [];

    addModuleRange(start: number, size: number, moduleName: string, pdbInfo?: PdbInfo) {
        this.moduleRanges.push({
            start,
            end: start + size,
            module: moduleName,
            pdbInfo
        });
        // Sort by start address for binary search
        this.moduleRanges.sort((a, b) => a.start - b.start);
    }

    findModule(address: number): { module: string; offset: number; pdbInfo?: PdbInfo } | null {
        // Binary search for efficiency
        let left = 0;
        let right = this.moduleRanges.length - 1;

        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            const range = this.moduleRanges[mid];

            if (address >= range.start && address < range.end) {
                return {
                    module: range.module,
                    offset: address - range.start,
                    pdbInfo: range.pdbInfo
                };
            }

            if (address < range.start) {
                right = mid - 1;
            } else {
                left = mid + 1;
            }
        }

        return null;
    }

    get(address: number): ResolvedSymbol | undefined {
        return this.cache.get(address);
    }

    set(address: number, symbol: ResolvedSymbol) {
        this.cache.set(address, symbol);
    }
}

export class SymbolResolver {
    private symbolCache = new SymbolCache();
    private knownSystemSymbols = new Map<string, Map<number, string>>();
    private symbolDatabase: any = null;
    private clientDownloader: any = null;

    constructor() {
        this.initializeKnownSymbols();
        this.initializeSymbolDatabase();
        this.initializeClientDownloader();
    }

    /**
     * Initialize symbol database for more accurate resolution
     */
    private async initializeSymbolDatabase() {
        try {
            // Dynamically import to avoid circular dependencies
            const { SymbolDatabase } = await import('./symbolDatabase');
            this.symbolDatabase = new SymbolDatabase();
            console.log('[SymbolResolver] Symbol database initialized');
        } catch (error) {
            console.warn('[SymbolResolver] Could not initialize symbol database:', error);
        }
    }

    /**
     * Initialize client-side symbol downloader
     */
    private async initializeClientDownloader() {
        try {
            const { ClientSymbolDownloader } = await import('./clientSymbolDownloader');
            this.clientDownloader = new ClientSymbolDownloader();
            console.log('[SymbolResolver] Client symbol downloader initialized');
        } catch (error) {
            console.warn('[SymbolResolver] Could not initialize client downloader:', error);
        }
    }

    /**
     * Initialize with known Windows kernel symbols
     * These are common functions we can identify by pattern
     */
    private initializeKnownSymbols() {
        // Common ntoskrnl.exe symbols (offsets are approximate)
        const ntSymbols = new Map<number, string>([
            [0x0, 'KeBugCheckEx'],
            [0x1000, 'KeBugCheck'],
            [0x2000, 'KiSystemServiceCopyEnd'],
            [0x3000, 'KiPageFault'],
            [0x4000, 'ExAllocatePoolWithTag'],
            [0x5000, 'ExFreePoolWithTag'],
            [0x6000, 'IoCompleteRequest'],
            [0x7000, 'KeWaitForSingleObject'],
            [0x8000, 'ObReferenceObjectByHandle'],
            [0x9000, 'ZwClose'],
            [0xA000, 'RtlCopyMemory'],
            [0xB000, 'memcpy'],
            [0xC000, 'KiDoubleFaultAbort'],
            [0xD000, 'KiGeneralProtectionFault'],
            [0xE000, 'KiPageFaultShadow'],
            [0xF000, 'ExpInterlockedPopEntrySListFault'],
        ]);
        this.knownSystemSymbols.set('nt', ntSymbols);
        this.knownSystemSymbols.set('ntoskrnl', ntSymbols);

        // HAL symbols
        this.knownSystemSymbols.set('hal', new Map([
            [0x0, 'HalProcessorIdle'],
            [0x1000, 'HalMakeBeep'],
            [0x2000, 'HalReturnToFirmware'],
            [0x3000, 'HalpCheckForSoftwareInterrupt'],
        ]));

        // Common driver symbols
        this.knownSystemSymbols.set('ndis', new Map([
            [0x0, 'NdisMIndicateReceiveNetBufferLists'],
            [0x1000, 'NdisAllocateNetBufferList'],
            [0x2000, 'NdisFreeNetBufferList'],
        ]));
    }

    /**
     * Extract PDB info from PE header in memory
     */
    extractPdbInfo(buffer: ArrayBuffer, offset: number): PdbInfo | null {
        const view = new DataView(buffer);
        
        try {
            // Check for PE signature
            if (view.getUint16(offset, true) !== 0x5A4D) { // MZ
                return null;
            }

            const peOffset = view.getUint32(offset + 0x3C, true);
            if (offset + peOffset + 4 > buffer.byteLength) {
                return null;
            }

            if (view.getUint32(offset + peOffset, true) !== 0x00004550) { // PE\0\0
                return null;
            }

            // Find debug directory
            const coffHeaderOffset = offset + peOffset + 4;
            const numberOfSections = view.getUint16(coffHeaderOffset + 2, true);
            const sizeOfOptionalHeader = view.getUint16(coffHeaderOffset + 16, true);
            const optionalHeaderOffset = coffHeaderOffset + 20;

            // Check if it's PE32+ (64-bit)
            const magic = view.getUint16(optionalHeaderOffset, true);
            const is64Bit = magic === 0x20B;

            // Debug directory is at different offsets for 32-bit vs 64-bit
            const debugDirOffset = optionalHeaderOffset + (is64Bit ? 144 : 128);
            if (debugDirOffset + 8 > buffer.byteLength) {
                return null;
            }

            const debugRVA = view.getUint32(debugDirOffset, true);
            const debugSize = view.getUint32(debugDirOffset + 4, true);

            if (debugRVA === 0 || debugSize === 0) {
                return null;
            }

            // Convert RVA to file offset (simplified - assumes first section)
            const sectionOffset = optionalHeaderOffset + sizeOfOptionalHeader;
            const firstSectionRVA = view.getUint32(sectionOffset + 12, true);
            const firstSectionFileOffset = view.getUint32(sectionOffset + 20, true);
            const debugFileOffset = offset + debugRVA - firstSectionRVA + firstSectionFileOffset;

            if (debugFileOffset + 28 > buffer.byteLength) {
                return null;
            }

            // Read debug directory entry
            const debugType = view.getUint32(debugFileOffset + 12, true);
            if (debugType !== 2) { // IMAGE_DEBUG_TYPE_CODEVIEW
                return null;
            }

            const codeViewOffset = offset + view.getUint32(debugFileOffset + 24, true);
            if (codeViewOffset + 24 > buffer.byteLength) {
                return null;
            }

            // Check for RSDS signature
            const signature = view.getUint32(codeViewOffset, true);
            if (signature !== 0x53445352) { // 'RSDS'
                return null;
            }

            // Read GUID (16 bytes)
            const guidBytes = new Uint8Array(buffer, codeViewOffset + 4, 16);
            const guid = Array.from(guidBytes)
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');

            const age = view.getUint32(codeViewOffset + 20, true);

            // Read null-terminated PDB filename
            let pdbFileName = '';
            let nameOffset = codeViewOffset + 24;
            while (nameOffset < buffer.byteLength) {
                const char = view.getUint8(nameOffset);
                if (char === 0) break;
                pdbFileName += String.fromCharCode(char);
                nameOffset++;
            }

            return {
                signature: 'RSDS',
                guid: guid.toUpperCase(),
                age,
                pdbFileName
            };
        } catch (e) {
            console.error('Error extracting PDB info:', e);
            return null;
        }
    }

    /**
     * Register a module with its address range
     */
    registerModule(baseAddress: number, size: number, moduleName: string, pdbInfo?: PdbInfo) {
        this.symbolCache.addModuleRange(baseAddress, size, moduleName, pdbInfo);
    }

    /**
     * Resolve an address to a symbol
     */
    resolve(address: number): ResolvedSymbol {
        // Check cache first
        const cached = this.symbolCache.get(address);
        if (cached) {
            return cached;
        }

        // Find which module contains this address
        const moduleInfo = this.symbolCache.findModule(address);
        if (!moduleInfo) {
            // Unknown module
            const symbol: ResolvedSymbol = {
                address,
                module: 'unknown',
                symbol: 'unknown',
                offset: 0,
                formatted: `0x${address.toString(16).padStart(16, '0')}`
            };
            this.symbolCache.set(address, symbol);
            return symbol;
        }

        // Try to resolve symbol within module
        const { module, offset, pdbInfo } = moduleInfo;
        const moduleName = module.replace(/\.(exe|dll|sys)$/i, '');
        
        // First try symbol database if available (most accurate)
        if (this.symbolDatabase) {
            const dbSymbol = this.symbolDatabase.findSymbol(module, offset);
            if (dbSymbol) {
                const symbol: ResolvedSymbol = {
                    address,
                    module: moduleName,
                    symbol: dbSymbol.name,
                    offset: dbSymbol.offset,
                    formatted: dbSymbol.offset > 0 
                        ? `${moduleName}!${dbSymbol.name}+0x${dbSymbol.offset.toString(16)}`
                        : `${moduleName}!${dbSymbol.name}`
                };
                this.symbolCache.set(address, symbol);
                return symbol;
            }
        }
        
        // Fall back to known symbols for this module
        const knownSymbols = this.knownSystemSymbols.get(moduleName.toLowerCase());
        if (knownSymbols) {
            // Find nearest symbol
            let nearestSymbol = '';
            let nearestOffset = offset;
            let minDistance = offset;

            for (const [symbolOffset, symbolName] of knownSymbols) {
                if (symbolOffset <= offset && (offset - symbolOffset) < minDistance) {
                    nearestSymbol = symbolName;
                    nearestOffset = offset - symbolOffset;
                    minDistance = offset - symbolOffset;
                }
            }

            if (nearestSymbol) {
                const symbol: ResolvedSymbol = {
                    address,
                    module: moduleName,
                    symbol: nearestSymbol,
                    offset: nearestOffset,
                    formatted: `${moduleName}!${nearestSymbol}+0x${nearestOffset.toString(16)}`
                };
                this.symbolCache.set(address, symbol);
                return symbol;
            }
        }

        // If we have PDB info but no symbol, show module+offset
        const symbol: ResolvedSymbol = {
            address,
            module: moduleName,
            symbol: pdbInfo ? `<${pdbInfo.pdbFileName}>` : 'unknown',
            offset: offset,
            formatted: `${moduleName}+0x${offset.toString(16)}`
        };
        
        this.symbolCache.set(address, symbol);
        return symbol;
    }

    /**
     * Resolve a batch of addresses
     */
    resolveBatch(addresses: number[]): ResolvedSymbol[] {
        return addresses.map(addr => this.resolve(addr));
    }

    /**
     * Async resolve with automatic symbol download
     */
    async resolveAsync(address: number): Promise<ResolvedSymbol> {
        // Try sync resolve first
        const syncResult = this.resolve(address);
        
        // If we got a good result, return it
        if (syncResult.module !== 'unknown' && syncResult.symbol !== 'unknown') {
            return syncResult;
        }
        
        // Try to download symbols if we have the downloader
        if (this.clientDownloader && syncResult.module !== 'unknown') {
            try {
                // Get module info
                const moduleInfo = this.symbolCache.findModule(address);
                if (moduleInfo) {
                    // Try to download symbols for this module
                    const downloaded = await this.clientDownloader.downloadModuleSymbols(moduleInfo.module);
                    
                    if (downloaded) {
                        // Try to resolve with downloaded symbols
                        const symbol = this.clientDownloader.resolve(moduleInfo.module, moduleInfo.offset);
                        if (symbol) {
                            const resolved: ResolvedSymbol = {
                                address,
                                module: moduleInfo.module.replace(/\.(exe|dll|sys)$/i, ''),
                                symbol: symbol.name,
                                offset: symbol.offset,
                                formatted: symbol.offset > 0 
                                    ? `${moduleInfo.module}!${symbol.name}+0x${symbol.offset.toString(16)}`
                                    : `${moduleInfo.module}!${symbol.name}`
                            };
                            
                            // Cache the result
                            this.symbolCache.set(address, resolved);
                            return resolved;
                        }
                    }
                }
            } catch (error) {
                console.warn('[SymbolResolver] Download failed:', error);
            }
        }
        
        // Return the sync result as fallback
        return syncResult;
    }

    /**
     * Format a resolved symbol for display
     */
    formatSymbol(symbol: ResolvedSymbol, includeAddress: boolean = false): string {
        if (includeAddress) {
            return `${symbol.formatted} (0x${symbol.address.toString(16).padStart(16, '0')})`;
        }
        return symbol.formatted;
    }

    /**
     * Generate symbol information for debugging
     */
    getSymbolSummary(): string {
        const modules = this.symbolCache['moduleRanges'];
        const summary = [`Symbol Resolution Summary:`, `${modules.length} modules loaded:`];
        
        for (const range of modules) {
            const size = range.end - range.start;
            summary.push(`  ${range.module}: 0x${range.start.toString(16)} - 0x${range.end.toString(16)} (${(size / 1024 / 1024).toFixed(2)} MB)`);
            if (range.pdbInfo) {
                summary.push(`    PDB: ${range.pdbInfo.pdbFileName}`);
                summary.push(`    GUID: ${range.pdbInfo.guid}, Age: ${range.pdbInfo.age}`);
            }
        }
        
        return summary.join('\n');
    }
}

/**
 * Pattern-based symbol detection for common crash scenarios
 */
export class PatternBasedSymbolDetector {
    private patterns = [
        {
            pattern: /DRIVER_IRQL_NOT_LESS_OR_EQUAL/,
            symbols: ['KfRaiseIrql', 'KeRaiseIrqlToDpcLevel', 'KeLowerIrql']
        },
        {
            pattern: /PAGE_FAULT_IN_NONPAGED_AREA/,
            symbols: ['MmAccessFault', 'MmCheckCachedPageStates', 'MiResolveDemandZeroFault']
        },
        {
            pattern: /KERNEL_MODE_HEAP_CORRUPTION/,
            symbols: ['RtlpHeapHandleError', 'RtlpBreakPointHeap', 'ExFreePoolWithTag']
        },
        {
            pattern: /DPC_WATCHDOG_VIOLATION/,
            symbols: ['KiUpdateRunTime', 'KeAccumulateTicks', 'KiDpcWatchdog']
        }
    ];

    suggestSymbols(bugCheckName: string): string[] {
        for (const { pattern, symbols } of this.patterns) {
            if (pattern.test(bugCheckName)) {
                return symbols;
            }
        }
        return [];
    }
}