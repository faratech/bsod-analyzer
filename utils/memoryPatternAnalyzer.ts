/**
 * Advanced memory pattern analysis for detecting corruption and anomalies
 */

export interface MemoryPattern {
    offset: number;
    size: number;
    pattern: string;
    description: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
}

export interface CorruptionIndicator {
    type: string;
    offset: number;
    details: string;
    confidence: number; // 0-100
}

export class MemoryPatternAnalyzer {
    private buffer: ArrayBuffer;
    private view: DataView;
    
    constructor(buffer: ArrayBuffer) {
        this.buffer = buffer;
        this.view = new DataView(buffer);
    }
    
    /**
     * Analyze memory for corruption patterns
     */
    public analyzeCorruptionPatterns(): CorruptionIndicator[] {
        const indicators: CorruptionIndicator[] = [];
        
        // Check for use-after-free patterns
        indicators.push(...this.detectUseAfterFree());
        
        // Check for buffer overflow patterns
        indicators.push(...this.detectBufferOverflow());
        
        // Check for double-free patterns
        indicators.push(...this.detectDoubleFree());
        
        // Check for uninitialized memory usage
        indicators.push(...this.detectUninitializedMemory());
        
        // Check for stack corruption
        indicators.push(...this.detectStackCorruption());
        
        // Check for heap corruption
        indicators.push(...this.detectHeapCorruption());
        
        return indicators;
    }
    
    /**
     * Detect use-after-free patterns
     */
    private detectUseAfterFree(): CorruptionIndicator[] {
        const indicators: CorruptionIndicator[] = [];
        
        // Ensure buffer is properly aligned for Uint32Array
        const alignedLength = Math.floor(this.buffer.byteLength / 4) * 4;
        if (alignedLength < 4) return indicators; // Buffer too small
        
        const alignedBuffer = alignedLength === this.buffer.byteLength 
            ? this.buffer 
            : this.buffer.slice(0, alignedLength);
        
        const uint32Array = new Uint32Array(alignedBuffer);
        
        // Common free patterns
        const freePatterns = [
            0xFEEEFEEE, // Freed heap memory (debug)
            0xDDDDDDDD, // Freed heap memory (CRT debug)
            0xDEADBEEF, // Common marker
            0xBAD0B0B0, // Bad memory marker
        ];
        
        // Scan for freed memory patterns
        for (let i = 0; i < uint32Array.length - 16; i++) {
            const value = uint32Array[i];
            
            for (const pattern of freePatterns) {
                if (value === pattern) {
                    // Check if multiple consecutive values match
                    let consecutiveCount = 1;
                    while (i + consecutiveCount < uint32Array.length && 
                           uint32Array[i + consecutiveCount] === pattern) {
                        consecutiveCount++;
                    }
                    
                    if (consecutiveCount >= 4) { // At least 16 bytes of pattern
                        indicators.push({
                            type: 'USE_AFTER_FREE',
                            offset: i * 4,
                            details: `Found ${consecutiveCount * 4} bytes of freed memory pattern 0x${pattern.toString(16).toUpperCase()}`,
                            confidence: Math.min(90, 50 + consecutiveCount * 5)
                        });
                        
                        i += consecutiveCount - 1; // Skip processed values
                    }
                }
            }
        }
        
        return indicators;
    }
    
    /**
     * Detect buffer overflow patterns
     */
    private detectBufferOverflow(): CorruptionIndicator[] {
        const indicators: CorruptionIndicator[] = [];
        const uint8Array = new Uint8Array(this.buffer);
        
        // Look for guard patterns that have been overwritten
        const guardPatterns = [
            [0xAB, 0xAB, 0xAB, 0xAB], // Heap guard
            [0xFD, 0xFD, 0xFD, 0xFD], // Guard bytes
            [0xCC, 0xCC, 0xCC, 0xCC], // Stack guard
        ];
        
        for (let i = 0; i < uint8Array.length - 64; i++) {
            // Check for partial guard patterns (indicating overflow)
            for (const guard of guardPatterns) {
                let matchCount = 0;
                for (let j = 0; j < 16; j++) {
                    if (uint8Array[i + j] === guard[j % 4]) {
                        matchCount++;
                    }
                }
                
                // If we have mostly guard bytes but some are different
                if (matchCount >= 12 && matchCount < 16) {
                    indicators.push({
                        type: 'BUFFER_OVERFLOW',
                        offset: i,
                        details: `Corrupted guard pattern detected, possible buffer overflow`,
                        confidence: 70
                    });
                }
            }
        }
        
        return indicators;
    }
    
    /**
     * Detect double-free patterns
     */
    private detectDoubleFree(): CorruptionIndicator[] {
        const indicators: CorruptionIndicator[] = [];
        
        // Look for heap metadata corruption typical of double-frees
        const heapSignatures = [
            { offset: 0, value: 0x00000000 },
            { offset: 4, value: 0xFEEEFEEE },
            { offset: 8, value: 0xFEEEFEEE },
        ];
        
        for (let i = 0; i < this.buffer.byteLength - 32; i += 8) {
            let matches = 0;
            
            for (const sig of heapSignatures) {
                if (i + sig.offset + 4 <= this.buffer.byteLength) {
                    const value = this.view.getUint32(i + sig.offset, true);
                    if (value === sig.value) matches++;
                }
            }
            
            if (matches >= 2) {
                indicators.push({
                    type: 'DOUBLE_FREE',
                    offset: i,
                    details: 'Heap metadata suggests possible double-free',
                    confidence: 60
                });
            }
        }
        
        return indicators;
    }
    
    /**
     * Detect uninitialized memory patterns
     */
    private detectUninitializedMemory(): CorruptionIndicator[] {
        const indicators: CorruptionIndicator[] = [];
        
        // Ensure buffer is properly aligned for Uint32Array
        const alignedLength = Math.floor(this.buffer.byteLength / 4) * 4;
        if (alignedLength < 4) return indicators; // Buffer too small
        
        const alignedBuffer = alignedLength === this.buffer.byteLength 
            ? this.buffer 
            : this.buffer.slice(0, alignedLength);
        
        const uint32Array = new Uint32Array(alignedBuffer);
        
        const uninitPatterns = [
            0xCDCDCDCD, // Uninitialized heap (debug)
            0xCCCCCCCC, // Uninitialized stack (debug)
            0xBAADF00D, // Bad food - uninitialized
            0x00000000, // Zeros (if extensive)
            0xFFFFFFFF, // All ones (if extensive)
        ];
        
        for (const pattern of uninitPatterns) {
            let maxConsecutive = 0;
            let currentConsecutive = 0;
            let startOffset = 0;
            
            for (let i = 0; i < uint32Array.length; i++) {
                if (uint32Array[i] === pattern) {
                    if (currentConsecutive === 0) startOffset = i * 4;
                    currentConsecutive++;
                } else {
                    if (currentConsecutive > maxConsecutive) {
                        maxConsecutive = currentConsecutive;
                        
                        if (maxConsecutive >= 64) { // At least 256 bytes
                            indicators.push({
                                type: 'UNINITIALIZED_MEMORY',
                                offset: startOffset,
                                details: `Found ${maxConsecutive * 4} bytes of pattern 0x${pattern.toString(16).toUpperCase()}`,
                                confidence: Math.min(85, 40 + maxConsecutive / 10)
                            });
                        }
                    }
                    currentConsecutive = 0;
                }
            }
        }
        
        return indicators;
    }
    
    /**
     * Detect stack corruption patterns
     */
    private detectStackCorruption(): CorruptionIndicator[] {
        const indicators: CorruptionIndicator[] = [];
        
        // Look for corrupted stack frames
        // Valid stack frames should have RBP chains
        for (let i = 0; i < this.buffer.byteLength - 32; i += 8) {
            const rbp = this.view.getBigUint64(i, true);
            const retAddr = this.view.getBigUint64(i + 8, true);
            
            // Check if this looks like a stack frame
            if (rbp > 0x7FF000000000n && rbp < 0x7FFFFFFFFFFFn) {
                // Check if return address is in code range
                if (retAddr >= 0xFFFF800000000000n || (retAddr >= 0x140000000n && retAddr < 0x7FF000000000n)) {
                    // Try to follow the chain
                    const nextRbpOffset = Number(rbp % BigInt(this.buffer.byteLength));
                    if (nextRbpOffset > 0 && nextRbpOffset < this.buffer.byteLength - 8) {
                        const nextRbp = this.view.getBigUint64(nextRbpOffset, true);
                        
                        // If chain is broken (next RBP is invalid)
                        if (nextRbp === 0n || nextRbp === 0xFFFFFFFFFFFFFFFFn) {
                            indicators.push({
                                type: 'STACK_CORRUPTION',
                                offset: i,
                                details: 'Broken stack frame chain detected',
                                confidence: 65
                            });
                        }
                    }
                }
            }
        }
        
        return indicators;
    }
    
    /**
     * Detect heap corruption patterns
     */
    private detectHeapCorruption(): CorruptionIndicator[] {
        const indicators: CorruptionIndicator[] = [];
        
        // Look for corrupted heap headers
        // Heap blocks typically have size/flags at -8 and -4 offsets
        for (let i = 16; i < this.buffer.byteLength - 32; i += 8) {
            const prevSize = this.view.getUint32(i - 8, true);
            const size = this.view.getUint32(i - 4, true);
            
            // Check for reasonable heap block sizes
            if (size > 0 && size < 0x100000 && (size & 0x7) === 0) { // Size should be 8-byte aligned
                // Check if next block's prevSize matches
                const nextBlockOffset = i + (size & 0xFFFFF8);
                if (nextBlockOffset < this.buffer.byteLength - 8) {
                    const nextPrevSize = this.view.getUint32(nextBlockOffset - 8, true);
                    
                    if (nextPrevSize !== (size & 0xFFFFF8)) {
                        indicators.push({
                            type: 'HEAP_CORRUPTION',
                            offset: i,
                            details: `Heap block size mismatch: ${size} vs ${nextPrevSize}`,
                            confidence: 75
                        });
                    }
                }
            }
        }
        
        return indicators;
    }
    
    /**
     * Find suspicious memory patterns
     */
    public findSuspiciousPatterns(): MemoryPattern[] {
        const patterns: MemoryPattern[] = [];
        const uint8Array = new Uint8Array(this.buffer);
        
        // Define suspicious patterns
        const suspiciousPatterns = [
            {
                bytes: [0x48, 0x8B, 0x0C, 0x25, 0x00, 0x00, 0x00, 0x00], // mov rcx, [0]
                description: 'NULL pointer dereference instruction',
                severity: 'critical' as const
            },
            {
                bytes: [0xEB, 0xFE], // jmp $-2 (infinite loop)
                description: 'Infinite loop detected',
                severity: 'high' as const
            },
            {
                bytes: [0x90, 0x90, 0x90, 0x90, 0x90, 0x90, 0x90, 0x90], // NOP sled
                description: 'NOP sled (possible shellcode)',
                severity: 'high' as const
            },
        ];
        
        // Search for patterns
        for (let i = 0; i < uint8Array.length - 32; i++) {
            for (const pattern of suspiciousPatterns) {
                let match = true;
                for (let j = 0; j < pattern.bytes.length; j++) {
                    if (uint8Array[i + j] !== pattern.bytes[j]) {
                        match = false;
                        break;
                    }
                }
                
                if (match) {
                    patterns.push({
                        offset: i,
                        size: pattern.bytes.length,
                        pattern: pattern.bytes.map(b => b.toString(16).padStart(2, '0')).join(' '),
                        description: pattern.description,
                        severity: pattern.severity
                    });
                }
            }
        }
        
        return patterns;
    }
}

/**
 * Analyze memory dump for patterns and corruption
 */
export function analyzeMemoryPatterns(buffer: ArrayBuffer): {
    corruption: CorruptionIndicator[];
    patterns: MemoryPattern[];
    summary: string;
} {
    const analyzer = new MemoryPatternAnalyzer(buffer);
    
    const corruption = analyzer.analyzeCorruptionPatterns();
    const patterns = analyzer.findSuspiciousPatterns();
    
    // Generate summary
    const criticalCount = corruption.filter(c => c.confidence >= 80).length;
    const highCount = corruption.filter(c => c.confidence >= 60 && c.confidence < 80).length;
    
    let summary = '';
    if (criticalCount > 0) {
        summary = `Critical: Found ${criticalCount} high-confidence corruption indicators. `;
    }
    if (highCount > 0) {
        summary += `Found ${highCount} medium-confidence anomalies. `;
    }
    if (patterns.filter(p => p.severity === 'critical').length > 0) {
        summary += 'Detected critical suspicious patterns in memory. ';
    }
    
    if (!summary) {
        summary = 'No significant memory corruption patterns detected.';
    }
    
    return {
        corruption,
        patterns,
        summary
    };
}