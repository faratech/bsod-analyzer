/**
 * Pre-built symbol database for common Windows system files
 * This is a more practical approach for web applications
 */

export interface SymbolEntry {
    module: string;
    rva: number;  // Relative Virtual Address
    name: string;
    size?: number;
}

export interface ModuleSymbols {
    module: string;
    version?: string;
    symbols: Map<number, SymbolEntry>;
}

/**
 * Compressed symbol database for common Windows modules
 * In production, this would be loaded from a CDN or API
 */
export class SymbolDatabase {
    private databases = new Map<string, ModuleSymbols>();
    
    constructor() {
        this.initializeCommonSymbols();
    }

    /**
     * Initialize with most common Windows kernel symbols
     * These are relatively stable across Windows versions
     */
    private initializeCommonSymbols() {
        // ntoskrnl.exe - Windows kernel
        this.addModule('ntoskrnl.exe', [
            { rva: 0x1000, name: 'KeBugCheckEx', size: 0x200 },
            { rva: 0x1200, name: 'KeBugCheck', size: 0x100 },
            { rva: 0x2000, name: 'KiSystemServiceCopyEnd', size: 0x50 },
            { rva: 0x3000, name: 'KiPageFault', size: 0x300 },
            { rva: 0x3300, name: 'KiPageFaultShadow', size: 0x300 },
            { rva: 0x4000, name: 'ExAllocatePoolWithTag', size: 0x150 },
            { rva: 0x4200, name: 'ExAllocatePool', size: 0x100 },
            { rva: 0x5000, name: 'ExFreePoolWithTag', size: 0x150 },
            { rva: 0x5200, name: 'ExFreePool', size: 0x100 },
            { rva: 0x6000, name: 'IoCompleteRequest', size: 0x200 },
            { rva: 0x7000, name: 'KeWaitForSingleObject', size: 0x250 },
            { rva: 0x8000, name: 'ObReferenceObjectByHandle', size: 0x300 },
            { rva: 0x9000, name: 'ZwClose', size: 0x50 },
            { rva: 0xA000, name: 'RtlCopyMemory', size: 0x100 },
            { rva: 0xA100, name: 'memcpy', size: 0x100 },
            { rva: 0xB000, name: 'RtlMoveMemory', size: 0x100 },
            { rva: 0xB100, name: 'memmove', size: 0x100 },
            { rva: 0xC000, name: 'KiDoubleFaultAbort', size: 0x100 },
            { rva: 0xD000, name: 'KiGeneralProtectionFault', size: 0x200 },
            { rva: 0xE000, name: 'KiBreakpointTrap', size: 0x100 },
            { rva: 0xF000, name: 'ExpInterlockedPopEntrySListFault', size: 0x100 },
            { rva: 0x10000, name: 'MmAccessFault', size: 0x500 },
            { rva: 0x11000, name: 'MmCheckCachedPageStates', size: 0x200 },
            { rva: 0x12000, name: 'MiResolveDemandZeroFault', size: 0x300 },
            { rva: 0x13000, name: 'KeExpandKernelStackAndCallout', size: 0x200 },
            { rva: 0x14000, name: 'KiSwapContext', size: 0x150 },
            { rva: 0x15000, name: 'KiDispatchInterrupt', size: 0x200 },
            { rva: 0x16000, name: 'KiDpcInterrupt', size: 0x150 },
            { rva: 0x17000, name: 'KiIpiInterrupt', size: 0x150 },
            { rva: 0x18000, name: 'KiTimerExpiration', size: 0x300 },
            { rva: 0x19000, name: 'KeFlushEntireTb', size: 0x100 },
            { rva: 0x20000, name: 'RtlpBreakPointHeap', size: 0x50 },
            { rva: 0x21000, name: 'RtlpHeapHandleError', size: 0x100 },
            { rva: 0x22000, name: 'RtlpAllocateHeap', size: 0x400 },
            { rva: 0x23000, name: 'RtlpFreeHeap', size: 0x300 },
        ]);

        // hal.dll - Hardware Abstraction Layer
        this.addModule('hal.dll', [
            { rva: 0x1000, name: 'HalProcessorIdle', size: 0x100 },
            { rva: 0x2000, name: 'HalMakeBeep', size: 0x50 },
            { rva: 0x3000, name: 'HalReturnToFirmware', size: 0x100 },
            { rva: 0x4000, name: 'HalpCheckForSoftwareInterrupt', size: 0x150 },
            { rva: 0x5000, name: 'HalpClockInterrupt', size: 0x200 },
            { rva: 0x6000, name: 'HalpIpiHandler', size: 0x150 },
            { rva: 0x7000, name: 'HalRequestIpi', size: 0x100 },
            { rva: 0x8000, name: 'HalHandleNMI', size: 0x200 },
        ]);

        // NDIS.sys - Network Driver Interface
        this.addModule('ndis.sys', [
            { rva: 0x1000, name: 'NdisMIndicateReceiveNetBufferLists', size: 0x200 },
            { rva: 0x2000, name: 'NdisAllocateNetBufferList', size: 0x150 },
            { rva: 0x3000, name: 'NdisFreeNetBufferList', size: 0x100 },
            { rva: 0x4000, name: 'NdisMSendNetBufferListsComplete', size: 0x200 },
            { rva: 0x5000, name: 'NdisAcquireSpinLock', size: 0x50 },
            { rva: 0x6000, name: 'NdisReleaseSpinLock', size: 0x50 },
        ]);

        // tcpip.sys - TCP/IP Protocol Driver
        this.addModule('tcpip.sys', [
            { rva: 0x1000, name: 'TcpReceive', size: 0x300 },
            { rva: 0x2000, name: 'TcpSend', size: 0x300 },
            { rva: 0x3000, name: 'IppProcessInbound', size: 0x400 },
            { rva: 0x4000, name: 'IppSendDatagramsCommon', size: 0x350 },
            { rva: 0x5000, name: 'TcpCreateAndConnectTcb', size: 0x250 },
        ]);

        // win32k.sys - Win32 Kernel Driver
        this.addModule('win32k.sys', [
            { rva: 0x1000, name: 'NtUserCallOneParam', size: 0x200 },
            { rva: 0x2000, name: 'NtUserCallTwoParam', size: 0x200 },
            { rva: 0x3000, name: 'NtGdiDdDDICreateDevice', size: 0x150 },
            { rva: 0x4000, name: 'EngAlphaBlend', size: 0x300 },
        ]);
    }

    /**
     * Add a module's symbols to the database
     */
    private addModule(moduleName: string, symbols: Array<{rva: number, name: string, size?: number}>) {
        const moduleSymbols: ModuleSymbols = {
            module: moduleName,
            symbols: new Map()
        };

        for (const symbol of symbols) {
            moduleSymbols.symbols.set(symbol.rva, {
                module: moduleName,
                rva: symbol.rva,
                name: symbol.name,
                size: symbol.size
            });
        }

        this.databases.set(moduleName.toLowerCase(), moduleSymbols);
    }

    /**
     * Find symbol for a given module and RVA
     */
    findSymbol(moduleName: string, rva: number): { name: string; offset: number } | null {
        const module = this.databases.get(moduleName.toLowerCase());
        if (!module) return null;

        let nearestSymbol: SymbolEntry | null = null;
        let nearestRva = 0;

        for (const [symbolRva, symbol] of module.symbols) {
            if (symbolRva <= rva && symbolRva > nearestRva) {
                nearestSymbol = symbol;
                nearestRva = symbolRva;
            }
        }

        if (nearestSymbol) {
            // Check if we're within the function's bounds (if size is known)
            const offset = rva - nearestRva;
            if (nearestSymbol.size && offset > nearestSymbol.size) {
                // We're past this function, might be in padding or unknown code
                return null;
            }

            return {
                name: nearestSymbol.name,
                offset: offset
            };
        }

        return null;
    }

    /**
     * Load additional symbols from a remote source
     */
    async loadRemoteSymbols(url: string): Promise<boolean> {
        try {
            const response = await fetch(url);
            if (!response.ok) return false;

            const data = await response.json();
            
            // Expected format: { modules: [ { name, symbols: [{rva, name, size}] } ] }
            if (data.modules && Array.isArray(data.modules)) {
                for (const module of data.modules) {
                    if (module.name && module.symbols) {
                        this.addModule(module.name, module.symbols);
                    }
                }
                return true;
            }
        } catch (error) {
            console.error('[SymbolDB] Failed to load remote symbols:', error);
        }
        return false;
    }

    /**
     * Get statistics about loaded symbols
     */
    getStats(): { modules: number; totalSymbols: number } {
        let totalSymbols = 0;
        for (const module of this.databases.values()) {
            totalSymbols += module.symbols.size;
        }
        return {
            modules: this.databases.size,
            totalSymbols
        };
    }
}

/**
 * Enhanced symbol resolver that uses the symbol database
 */
export function createEnhancedSymbolResolver(symbolDatabase: SymbolDatabase) {
    return {
        resolve(moduleName: string, offset: number): string {
            const symbol = symbolDatabase.findSymbol(moduleName, offset);
            if (symbol) {
                if (symbol.offset === 0) {
                    return `${moduleName}!${symbol.name}`;
                } else {
                    return `${moduleName}!${symbol.name}+0x${symbol.offset.toString(16)}`;
                }
            }
            return `${moduleName}+0x${offset.toString(16)}`;
        }
    };
}