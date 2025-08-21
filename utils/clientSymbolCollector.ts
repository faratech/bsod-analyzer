/**
 * Client-side symbol collection with user consent
 * Gathers anonymous symbol data to improve the database
 */

export interface CollectedSymbolData {
    // Anonymous identifier (hash of dump file)
    dumpHash: string;
    
    // Timestamp (rounded to day for privacy)
    timestamp: string;
    
    // OS version (major.minor only)
    osVersion: string;
    
    // Collected symbols
    symbols: Array<{
        module: string;
        offset: number;
        symbol?: string;
        confidence: number;
    }>;
    
    // Module information (no paths, just names and sizes)
    modules: Array<{
        name: string;
        size: number;
        hasSymbols: boolean;
    }>;
    
    // Crash context (anonymous)
    crashContext: {
        bugCheckCode: string;
        stackDepth: number;
        hasThirdPartyDrivers: boolean;
    };
}

export class ClientSymbolCollector {
    private static STORAGE_KEY = 'bsod_symbol_collection';
    private static MAX_STORED_DUMPS = 100;
    
    /**
     * Check if user has consented to symbol collection
     */
    static hasUserConsent(): boolean {
        return localStorage.getItem('symbol_collection_consent') === 'true';
    }
    
    /**
     * Request user consent for symbol collection
     */
    static async requestConsent(): Promise<boolean> {
        // This would show a UI dialog explaining:
        // - What data is collected (anonymous symbols only)
        // - How it helps improve the tool
        // - That no personal data is collected
        // - Option to opt out anytime
        
        // For now, return false (no collection without explicit implementation)
        return false;
    }
    
    /**
     * Collect symbols from a dump file (if consented)
     */
    static async collectFromDump(
        buffer: ArrayBuffer, 
        structuredInfo: any,
        stackTrace: string[]
    ): Promise<void> {
        if (!this.hasUserConsent()) {
            return;
        }
        
        try {
            // Generate anonymous hash of dump
            const hashBuffer = await crypto.subtle.digest('SHA-256', buffer.slice(0, 1024));
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const dumpHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            
            // Round timestamp to day for privacy
            const now = new Date();
            now.setHours(0, 0, 0, 0);
            
            // Extract OS version (major.minor only)
            const osVersion = this.extractOSVersion(structuredInfo);
            
            // Collect symbol data
            const collectedData: CollectedSymbolData = {
                dumpHash: dumpHash.substring(0, 16), // First 16 chars only
                timestamp: now.toISOString().split('T')[0],
                osVersion,
                symbols: this.extractSymbols(structuredInfo, stackTrace),
                modules: this.extractModuleInfo(structuredInfo),
                crashContext: {
                    bugCheckCode: structuredInfo.bugCheckInfo ? 
                        `0x${structuredInfo.bugCheckInfo.code.toString(16).padStart(8, '0')}` : 
                        'unknown',
                    stackDepth: stackTrace.length,
                    hasThirdPartyDrivers: this.hasThirdPartyDrivers(structuredInfo)
                }
            };
            
            // Store locally (would be sent to server in batches)
            this.storeCollectedData(collectedData);
            
        } catch (error) {
            console.error('[SymbolCollector] Error collecting symbols:', error);
        }
    }
    
    /**
     * Extract symbols from dump data
     */
    private static extractSymbols(structuredInfo: any, stackTrace: string[]): any[] {
        const symbols: any[] = [];
        
        // Extract from stack trace
        for (const frame of stackTrace) {
            const match = frame.match(/^([^!]+)!([^+]+)(?:\+0x([0-9a-fA-F]+))?$/);
            if (match) {
                symbols.push({
                    module: match[1],
                    symbol: match[2],
                    offset: match[3] ? parseInt(match[3], 16) : 0,
                    confidence: 100 // High confidence for exact matches
                });
            } else if (frame.match(/^([^+]+)\+0x([0-9a-fA-F]+)$/)) {
                const moduleMatch = frame.match(/^([^+]+)\+0x([0-9a-fA-F]+)$/);
                if (moduleMatch) {
                    symbols.push({
                        module: moduleMatch[1],
                        offset: parseInt(moduleMatch[2], 16),
                        confidence: 50 // Medium confidence for offset-only
                    });
                }
            }
        }
        
        return symbols;
    }
    
    /**
     * Extract module information (anonymized)
     */
    private static extractModuleInfo(structuredInfo: any): any[] {
        if (!structuredInfo.moduleList) return [];
        
        return structuredInfo.moduleList.map((module: any) => ({
            name: module.name,
            size: module.size || 0,
            hasSymbols: !!(module.cvRecord && module.cvRecord.pdbFileName)
        }));
    }
    
    /**
     * Extract OS version (privacy-preserving)
     */
    private static extractOSVersion(structuredInfo: any): string {
        if (structuredInfo.systemInfo) {
            const major = structuredInfo.systemInfo.majorVersion || 0;
            const minor = structuredInfo.systemInfo.minorVersion || 0;
            return `${major}.${minor}`;
        }
        return 'unknown';
    }
    
    /**
     * Check for third-party drivers
     */
    private static hasThirdPartyDrivers(structuredInfo: any): boolean {
        if (!structuredInfo.moduleList) return false;
        
        const microsoftPrefixes = [
            'nt', 'hal', 'win32k', 'ndis', 'tcpip', 'afd', 'rdbss',
            'srv', 'fltmgr', 'ntfs', 'partmgr', 'disk', 'acpi', 'pci'
        ];
        
        return structuredInfo.moduleList.some((module: any) => {
            const name = module.name.toLowerCase();
            return !microsoftPrefixes.some(prefix => name.startsWith(prefix));
        });
    }
    
    /**
     * Store collected data locally
     */
    private static storeCollectedData(data: CollectedSymbolData): void {
        try {
            const stored = localStorage.getItem(this.STORAGE_KEY);
            const collection = stored ? JSON.parse(stored) : [];
            
            // Add new data
            collection.push(data);
            
            // Limit storage size
            if (collection.length > this.MAX_STORED_DUMPS) {
                collection.shift(); // Remove oldest
            }
            
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(collection));
        } catch (error) {
            console.error('[SymbolCollector] Storage error:', error);
        }
    }
    
    /**
     * Get aggregated statistics (for display to user)
     */
    static getStatistics(): any {
        try {
            const stored = localStorage.getItem(this.STORAGE_KEY);
            if (!stored) return null;
            
            const collection = JSON.parse(stored);
            
            // Aggregate statistics
            const stats = {
                totalDumps: collection.length,
                uniqueModules: new Set(collection.flatMap((d: any) => 
                    d.modules.map((m: any) => m.name)
                )).size,
                uniqueSymbols: new Set(collection.flatMap((d: any) => 
                    d.symbols.filter((s: any) => s.symbol).map((s: any) => s.symbol)
                )).size,
                commonCrashCodes: this.getCommonCrashCodes(collection),
                contribution: {
                    symbols: collection.reduce((acc: number, d: any) => 
                        acc + d.symbols.filter((s: any) => s.symbol).length, 0
                    ),
                    modules: collection.reduce((acc: number, d: any) => 
                        acc + d.modules.length, 0
                    )
                }
            };
            
            return stats;
        } catch (error) {
            console.error('[SymbolCollector] Statistics error:', error);
            return null;
        }
    }
    
    /**
     * Get common crash codes from collected data
     */
    private static getCommonCrashCodes(collection: any[]): any[] {
        const counts = new Map<string, number>();
        
        for (const data of collection) {
            const code = data.crashContext.bugCheckCode;
            counts.set(code, (counts.get(code) || 0) + 1);
        }
        
        return Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([code, count]) => ({ code, count }));
    }
    
    /**
     * Export collected data for manual submission
     */
    static exportData(): string | null {
        const stored = localStorage.getItem(this.STORAGE_KEY);
        if (!stored) return null;
        
        // Create anonymized export
        const data = JSON.parse(stored);
        const anonymized = {
            version: 1,
            timestamp: new Date().toISOString(),
            data: data,
            // Remove any potentially identifying information
            metadata: {
                toolVersion: '1.0',
                dataPoints: data.length
            }
        };
        
        return JSON.stringify(anonymized, null, 2);
    }
    
    /**
     * Clear all collected data
     */
    static clearData(): void {
        localStorage.removeItem(this.STORAGE_KEY);
        console.log('[SymbolCollector] All collected data cleared');
    }
}