/**
 * Cloud-native symbol collection service
 * Designed for stateless environments like Cloud Run
 */

export interface CloudSymbolConfig {
    // Option 1: Google Firestore (Recommended for Cloud Run)
    firestoreConfig?: {
        projectId: string;
        collectionName: string;
    };
    
    // Option 2: Google Cloud Storage
    gcsConfig?: {
        bucketName: string;
        prefix: string;
    };
    
    // Option 3: External API
    apiConfig?: {
        endpoint: string;
        apiKey: string;
    };
    
    // Option 4: BigQuery for analytics
    bigQueryConfig?: {
        datasetId: string;
        tableId: string;
    };
}

/**
 * Client-side only symbol collection
 * All data stays in browser until explicitly sent
 */
export class BrowserOnlySymbolCollector {
    private static readonly STORAGE_KEY = 'bsod_symbols_pending';
    private static readonly CONSENT_KEY = 'bsod_symbol_consent';
    
    /**
     * Collect symbols in browser storage only
     */
    static collectLocally(dumpData: any): void {
        if (!this.hasConsent()) return;
        
        const symbols = {
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            symbols: this.extractSymbols(dumpData),
            metadata: {
                bugCheckCode: dumpData.bugCheckCode,
                moduleCount: dumpData.modules?.length || 0,
                osVersion: dumpData.osVersion
            }
        };
        
        // Store in IndexedDB (larger capacity than localStorage)
        this.storeInIndexedDB(symbols);
    }
    
    /**
     * User-initiated upload to cloud
     */
    static async uploadToCloud(): Promise<boolean> {
        const pendingData = await this.getPendingData();
        if (pendingData.length === 0) return true;
        
        try {
            // Send to Cloud Run endpoint
            const response = await fetch('/api/symbols/submit', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    // Anonymous batch submission
                    batch: pendingData.map(item => ({
                        symbols: item.symbols,
                        metadata: item.metadata,
                        // No personal identifiers
                    }))
                })
            });
            
            if (response.ok) {
                await this.clearPendingData();
                return true;
            }
        } catch (error) {
            console.error('[CloudSymbols] Upload failed:', error);
        }
        
        return false;
    }
    
    /**
     * Get consent status
     */
    static hasConsent(): boolean {
        return localStorage.getItem(this.CONSENT_KEY) === 'true';
    }
    
    /**
     * Set consent with expiry
     */
    static setConsent(consent: boolean): void {
        if (consent) {
            // Consent expires after 1 year
            const expiry = new Date();
            expiry.setFullYear(expiry.getFullYear() + 1);
            localStorage.setItem(this.CONSENT_KEY, 'true');
            localStorage.setItem(this.CONSENT_KEY + '_expiry', expiry.toISOString());
        } else {
            localStorage.removeItem(this.CONSENT_KEY);
            localStorage.removeItem(this.CONSENT_KEY + '_expiry');
            // Clear any pending data
            this.clearPendingData();
        }
    }
    
    /**
     * Store in IndexedDB for larger capacity
     */
    private static async storeInIndexedDB(data: any): Promise<void> {
        const db = await this.openDB();
        const tx = db.transaction(['symbols'], 'readwrite');
        await tx.objectStore('symbols').add(data);
    }
    
    /**
     * Get pending data from IndexedDB
     */
    private static async getPendingData(): Promise<any[]> {
        const db = await this.openDB();
        const tx = db.transaction(['symbols'], 'readonly');
        return tx.objectStore('symbols').getAll();
    }
    
    /**
     * Clear pending data
     */
    private static async clearPendingData(): Promise<void> {
        const db = await this.openDB();
        const tx = db.transaction(['symbols'], 'readwrite');
        await tx.objectStore('symbols').clear();
    }
    
    /**
     * Open IndexedDB
     */
    private static async openDB(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('BSODAnalyzer', 1);
            
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
            
            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                if (!db.objectStoreNames.contains('symbols')) {
                    db.createObjectStore('symbols', { keyPath: 'id' });
                }
            };
        });
    }
    
    /**
     * Extract symbols (simplified)
     */
    private static extractSymbols(dumpData: any): any[] {
        // Extract symbol data without any personal information
        return dumpData.stackTrace?.map((frame: string) => {
            const match = frame.match(/^([^!]+)!([^+]+)(?:\+0x([0-9a-fA-F]+))?$/);
            if (match) {
                return {
                    module: match[1],
                    symbol: match[2],
                    offset: match[3] || '0'
                };
            }
            return null;
        }).filter(Boolean) || [];
    }
    
    /**
     * Get statistics for user
     */
    static async getStatistics(): Promise<any> {
        const pending = await this.getPendingData();
        return {
            pendingUploads: pending.length,
            totalSymbols: pending.reduce((acc, item) => acc + item.symbols.length, 0),
            oldestEntry: pending.length > 0 ? pending[0].timestamp : null,
            storageUsed: await this.estimateStorageUsed()
        };
    }
    
    /**
     * Estimate storage used
     */
    private static async estimateStorageUsed(): Promise<string> {
        if ('storage' in navigator && 'estimate' in navigator.storage) {
            const estimate = await navigator.storage.estimate();
            const used = estimate.usage || 0;
            return `${(used / 1024 / 1024).toFixed(2)} MB`;
        }
        return 'Unknown';
    }
}

/**
 * Server-side handler for Cloud Run
 */
export class CloudRunSymbolHandler {
    /**
     * Handle symbol submission endpoint
     * This would go in your Cloud Run server.js
     */
    static async handleSubmission(req: any, res: any): Promise<void> {
        try {
            const { batch } = req.body;
            
            if (!batch || !Array.isArray(batch)) {
                res.status(400).json({ error: 'Invalid submission format' });
                return;
            }
            
            // Process batch without storing on Cloud Run
            const processed = batch.map(item => ({
                // Hash for deduplication
                hash: this.hashSymbolData(item),
                symbols: item.symbols,
                metadata: {
                    ...item.metadata,
                    submittedAt: new Date().toISOString(),
                    // Add server-side metadata
                    region: process.env.REGION || 'unknown'
                }
            }));
            
            // Option 1: Send to Firestore (Recommended)
            // await this.sendToFirestore(processed);
            
            // Option 2: Send to Cloud Storage as JSONL
            // await this.sendToCloudStorage(processed);
            
            // Option 3: Stream to BigQuery for analytics
            // await this.streamToBigQuery(processed);
            
            // Option 4: Forward to external service
            // await this.forwardToExternalAPI(processed);
            
            // For now, just log and acknowledge
            console.log(`[CloudSymbols] Received ${batch.length} symbol batches`);
            
            res.json({ 
                success: true, 
                processed: batch.length,
                message: 'Symbols received for processing'
            });
            
        } catch (error) {
            console.error('[CloudSymbols] Processing error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    
    /**
     * Hash symbol data for deduplication
     */
    private static hashSymbolData(data: any): string {
        const content = JSON.stringify(data.symbols);
        // Simple hash for deduplication
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash).toString(16);
    }
}

/**
 * Static CDN-hosted symbol database
 * Best approach for Cloud Run - no persistence needed
 */
export class CDNSymbolDatabase {
    private static readonly CDN_BASE = 'https://cdn.jsdelivr.net/gh/yourusername/bsod-symbols@latest/';
    private static symbolCache = new Map<string, any>();
    
    /**
     * Load symbol database from CDN
     */
    static async loadSymbols(): Promise<void> {
        try {
            // Load pre-built symbol database from CDN
            const response = await fetch(this.CDN_BASE + 'symbols.json');
            if (response.ok) {
                const data = await response.json();
                
                // Cache in memory for this session
                for (const [module, symbols] of Object.entries(data)) {
                    this.symbolCache.set(module, symbols);
                }
                
                console.log(`[CDNSymbols] Loaded ${this.symbolCache.size} modules from CDN`);
            }
        } catch (error) {
            console.error('[CDNSymbols] Failed to load from CDN:', error);
            // Fall back to built-in minimal symbols
        }
    }
    
    /**
     * Resolve symbol from CDN data
     */
    static resolveSymbol(module: string, offset: number): string | null {
        const moduleSymbols = this.symbolCache.get(module.toLowerCase());
        if (!moduleSymbols) return null;
        
        // Find nearest symbol
        let nearest = null;
        let nearestOffset = Infinity;
        
        for (const [rva, symbol] of Object.entries(moduleSymbols)) {
            const symbolRva = parseInt(rva);
            if (symbolRva <= offset && (offset - symbolRva) < nearestOffset) {
                nearest = symbol;
                nearestOffset = offset - symbolRva;
            }
        }
        
        if (nearest) {
            return nearestOffset > 0 
                ? `${module}!${nearest}+0x${nearestOffset.toString(16)}`
                : `${module}!${nearest}`;
        }
        
        return null;
    }
}