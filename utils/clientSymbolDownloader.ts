/**
 * Client-side symbol downloader
 * Downloads symbols on-demand from public sources without persistence
 */

export interface SymbolSource {
    name: string;
    baseUrl: string;
    type: 'json' | 'csv' | 'text';
    modules: string[];
}

// Public symbol sources (CDN-hosted)
const SYMBOL_SOURCES: SymbolSource[] = [
    {
        name: 'Local Symbols',
        baseUrl: '/symbols/',
        type: 'json',
        modules: ['ntoskrnl.exe', 'ntkrnlmp.exe', 'hal.dll', 'win32k.sys', 'ndis.sys', 'tcpip.sys', 'afd.sys', 'http.sys', 'netio.sys', 'storport.sys', 'ataport.sys', 'disk.sys', 'partmgr.sys', 'volmgr.sys', 'mountmgr.sys', 'volsnap.sys', 'ntfs.sys', 'fastfat.sys', 'exfat.sys', 'refs.sys', 'fltmgr.sys', 'pci.sys', 'acpi.sys', 'intelppm.sys', 'amdppm.sys', 'usbhub.sys', 'usbport.sys', 'usbehci.sys', 'usbxhci.sys', 'usbhub3.sys', 'dxgkrnl.sys', 'dxgmms1.sys', 'dxgmms2.sys', 'nvlddmkm.sys', 'atikmdag.sys', 'igdkmd64.sys', 'ksecdd.sys', 'cng.sys', 'msrpc.sys', 'srv.sys', 'srv2.sys', 'srvnet.sys', 'mrxsmb.sys', 'rdbss.sys']
    },
    {
        name: 'GitHub CDN',
        baseUrl: 'https://cdn.jsdelivr.net/gh/faratech/bsod-analyzer@main/public/symbols/',
        type: 'json',
        modules: ['ntoskrnl.exe', 'hal.dll', 'win32k.sys', 'ndis.sys', 'tcpip.sys']
    }
];

export class ClientSymbolDownloader {
    private downloadedSymbols = new Map<string, Map<number, string>>();
    private downloadPromises = new Map<string, Promise<void>>();
    private failedModules = new Set<string>();

    /**
     * Download symbols for a specific module
     */
    async downloadModuleSymbols(moduleName: string): Promise<boolean> {
        const normalizedName = moduleName.toLowerCase();
        
        // Already downloaded
        if (this.downloadedSymbols.has(normalizedName)) {
            return true;
        }
        
        // Already failed
        if (this.failedModules.has(normalizedName)) {
            return false;
        }
        
        // Download in progress
        if (this.downloadPromises.has(normalizedName)) {
            await this.downloadPromises.get(normalizedName);
            return this.downloadedSymbols.has(normalizedName);
        }
        
        // Start new download
        const downloadPromise = this.performDownload(moduleName);
        this.downloadPromises.set(normalizedName, downloadPromise);
        
        try {
            await downloadPromise;
            return this.downloadedSymbols.has(normalizedName);
        } finally {
            this.downloadPromises.delete(normalizedName);
        }
    }

    /**
     * Perform the actual download
     */
    private async performDownload(moduleName: string): Promise<void> {
        const normalizedName = moduleName.toLowerCase();
        
        // Find a source that has this module
        for (const source of SYMBOL_SOURCES) {
            if (source.modules.some(m => m.toLowerCase() === normalizedName)) {
                try {
                    console.log(`[SymbolDownloader] Downloading ${moduleName} from ${source.name}`);
                    
                    const url = `${source.baseUrl}${normalizedName}.${source.type}`;
                    
                    // Add timeout and error handling
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
                    
                    const response = await fetch(url, {
                        signal: controller.signal,
                        mode: 'cors',
                        credentials: 'omit'
                    });
                    
                    clearTimeout(timeoutId);
                    
                    if (!response.ok) {
                        console.warn(`[SymbolDownloader] Failed to download ${moduleName} from ${source.name}: ${response.status}`);
                        continue;
                    }
                    
                    const data = await this.parseSymbolData(response, source.type);
                    if (data && data.size > 0) {
                        this.downloadedSymbols.set(normalizedName, data);
                        console.log(`[SymbolDownloader] Downloaded ${data.size} symbols for ${moduleName}`);
                        return;
                    }
                } catch (error) {
                    clearTimeout(timeoutId);
                    if (error.name === 'AbortError') {
                        console.warn(`[SymbolDownloader] Timeout downloading ${moduleName} from ${source.name}`);
                    } else {
                        console.error(`[SymbolDownloader] Error downloading ${moduleName} from ${source.name}:`, error);
                    }
                }
            }
        }
        
        // Mark as failed if we couldn't download from any source
        this.failedModules.add(normalizedName);
        console.warn(`[SymbolDownloader] No symbols found for ${moduleName}`);
    }

    /**
     * Parse symbol data based on format
     */
    private async parseSymbolData(response: Response, type: string): Promise<Map<number, string> | null> {
        try {
            switch (type) {
                case 'json':
                    const json = await response.json();
                    return this.parseJsonSymbols(json);
                
                case 'csv':
                    const csv = await response.text();
                    return this.parseCsvSymbols(csv);
                
                case 'text':
                    const text = await response.text();
                    return this.parseTextSymbols(text);
                
                default:
                    return null;
            }
        } catch (error) {
            console.error('[SymbolDownloader] Parse error:', error);
            return null;
        }
    }

    /**
     * Parse JSON format symbols
     * Expected format: { "0x1000": "FunctionName", ... }
     */
    private parseJsonSymbols(data: any): Map<number, string> {
        const symbols = new Map<number, string>();
        
        if (typeof data === 'object') {
            for (const [rva, name] of Object.entries(data)) {
                const address = parseInt(rva, rva.startsWith('0x') ? 16 : 10);
                if (!isNaN(address) && typeof name === 'string') {
                    symbols.set(address, name);
                }
            }
        }
        
        return symbols;
    }

    /**
     * Parse CSV format symbols
     * Expected format: RVA,Name
     */
    private parseCsvSymbols(csv: string): Map<number, string> {
        const symbols = new Map<number, string>();
        const lines = csv.split('\n');
        
        for (const line of lines) {
            const [rva, name] = line.split(',').map(s => s.trim());
            if (rva && name) {
                const address = parseInt(rva, rva.startsWith('0x') ? 16 : 10);
                if (!isNaN(address)) {
                    symbols.set(address, name);
                }
            }
        }
        
        return symbols;
    }

    /**
     * Parse text format symbols
     * Expected format: 00001000 FunctionName
     */
    private parseTextSymbols(text: string): Map<number, string> {
        const symbols = new Map<number, string>();
        const lines = text.split('\n');
        
        for (const line of lines) {
            const match = line.match(/^\s*([0-9a-fA-F]+)\s+(.+)$/);
            if (match) {
                const address = parseInt(match[1], 16);
                const name = match[2].trim();
                if (!isNaN(address) && name) {
                    symbols.set(address, name);
                }
            }
        }
        
        return symbols;
    }

    /**
     * Resolve a symbol using downloaded data
     */
    resolve(moduleName: string, offset: number): { name: string; offset: number } | null {
        const normalizedName = moduleName.toLowerCase();
        const moduleSymbols = this.downloadedSymbols.get(normalizedName);
        
        if (!moduleSymbols) {
            return null;
        }
        
        // Find nearest symbol
        let nearestName = '';
        let nearestRva = 0;
        
        for (const [rva, name] of moduleSymbols) {
            if (rva <= offset && rva > nearestRva) {
                nearestName = name;
                nearestRva = rva;
            }
        }
        
        if (nearestName) {
            return {
                name: nearestName,
                offset: offset - nearestRva
            };
        }
        
        return null;
    }

    /**
     * Get download statistics
     */
    getStats(): {
        downloadedModules: number;
        totalSymbols: number;
        failedModules: number;
        pendingDownloads: number;
    } {
        let totalSymbols = 0;
        for (const symbols of this.downloadedSymbols.values()) {
            totalSymbols += symbols.size;
        }
        
        return {
            downloadedModules: this.downloadedSymbols.size,
            totalSymbols,
            failedModules: this.failedModules.size,
            pendingDownloads: this.downloadPromises.size
        };
    }

    /**
     * Clear all downloaded symbols (free memory)
     */
    clear(): void {
        this.downloadedSymbols.clear();
        this.failedModules.clear();
        // Don't clear promises as they might be in progress
    }
}

/**
 * Integration with SymbolResolver
 */
export class EnhancedSymbolResolver {
    private downloader = new ClientSymbolDownloader();
    private resolveCache = new Map<string, string>();

    /**
     * Resolve symbol with automatic download
     */
    async resolveWithDownload(
        moduleName: string, 
        baseAddress: number, 
        targetAddress: number
    ): Promise<string> {
        const offset = targetAddress - baseAddress;
        const cacheKey = `${moduleName}:${offset}`;
        
        // Check cache
        if (this.resolveCache.has(cacheKey)) {
            return this.resolveCache.get(cacheKey)!;
        }
        
        // Try to download symbols for this module
        const downloaded = await this.downloader.downloadModuleSymbols(moduleName);
        
        if (downloaded) {
            const symbol = this.downloader.resolve(moduleName, offset);
            if (symbol) {
                const formatted = symbol.offset > 0
                    ? `${moduleName}!${symbol.name}+0x${symbol.offset.toString(16)}`
                    : `${moduleName}!${symbol.name}`;
                
                this.resolveCache.set(cacheKey, formatted);
                return formatted;
            }
        }
        
        // Fallback to module+offset
        const fallback = `${moduleName}+0x${offset.toString(16)}`;
        this.resolveCache.set(cacheKey, fallback);
        return fallback;
    }

    /**
     * Batch resolve with progress callback
     */
    async resolveBatch(
        requests: Array<{ module: string; base: number; address: number }>,
        onProgress?: (current: number, total: number) => void
    ): Promise<string[]> {
        const results: string[] = [];
        
        // Group by module to minimize downloads
        const moduleGroups = new Map<string, typeof requests>();
        for (const req of requests) {
            if (!moduleGroups.has(req.module)) {
                moduleGroups.set(req.module, []);
            }
            moduleGroups.get(req.module)!.push(req);
        }
        
        // Download all needed modules first
        let downloadCount = 0;
        for (const module of moduleGroups.keys()) {
            await this.downloader.downloadModuleSymbols(module);
            downloadCount++;
            if (onProgress) {
                onProgress(downloadCount, moduleGroups.size);
            }
        }
        
        // Now resolve all symbols
        for (const req of requests) {
            const resolved = await this.resolveWithDownload(req.module, req.base, req.address);
            results.push(resolved);
        }
        
        return results;
    }

    /**
     * Get downloader statistics
     */
    getStats() {
        return this.downloader.getStats();
    }
}

/**
 * React hook for symbol resolution
 */
export function useSymbolResolver() {
    const [resolver] = React.useState(() => new EnhancedSymbolResolver());
    const [stats, setStats] = React.useState(resolver.getStats());
    
    const resolve = React.useCallback(async (module: string, base: number, address: number) => {
        const result = await resolver.resolveWithDownload(module, base, address);
        setStats(resolver.getStats());
        return result;
    }, [resolver]);
    
    const resolveBatch = React.useCallback(async (
        requests: Array<{ module: string; base: number; address: number }>,
        onProgress?: (current: number, total: number) => void
    ) => {
        const results = await resolver.resolveBatch(requests, onProgress);
        setStats(resolver.getStats());
        return results;
    }, [resolver]);
    
    return { resolve, resolveBatch, stats };
}