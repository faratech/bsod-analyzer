// Separate module for stack extraction to avoid parsing issues
import { SymbolResolver } from './symbolResolver';

// Windows x64 virtual address space constants
const VIRTUAL_ADDRESS_MASK = 0xFFFFFFFFFFFFn;
const PAGE_SIZE = 4096n;
const PAGE_MASK = PAGE_SIZE - 1n;
const PAGE_SHIFT = 12n;

// x64 paging structure
const PML4_SHIFT = 39n;
const PDPT_SHIFT = 30n;
const PD_SHIFT = 21n;
const PT_SHIFT = 12n;
const OFFSET_MASK = 0xFFFn;

// Page table entry flags
const PTE_VALID = 0x1n;
const PTE_WRITE = 0x2n;
const PTE_LARGE = 0x80n;
const PTE_PFN_MASK = 0x000FFFFFFFFFF000n;

interface PhysicalMemoryRun {
    basePage: bigint;
    pageCount: bigint;
}

interface DumpContext {
    rsp?: bigint;
    rbp?: bigint;
    cr3?: bigint;  // Page table base
    physicalMemoryRuns?: PhysicalMemoryRun[];
}

export function extractStackFrames(buffer: ArrayBuffer, context: DumpContext | null, symbolResolver?: SymbolResolver): string[] {
    // If we have context with CR3 (page table base), try proper virtual to physical translation
    if (context && context.rsp && context.rbp && context.cr3) {
        const frames = walkStackWithTranslation(buffer, context);
        if (frames.length > 0) {
            return frames;
        }
    }
    
    // If we have context but no CR3, try simplified stack walking
    if (context && context.rsp && context.rbp) {
        const frames = walkStack(buffer, context.rbp);
        if (frames.length > 0) {
            return frames;
        }
    }
    
    // Fall back to pattern extraction
    return extractPatterns(buffer);
}

// Virtual to physical address translation for x64 4-level paging
function virtualToPhysical(buffer: ArrayBuffer, virtualAddr: bigint, cr3: bigint): bigint | null {
    const view = new DataView(buffer);
    
    // Extract indices for each paging level
    const pml4Index = (virtualAddr >> PML4_SHIFT) & 0x1FFn;
    const pdptIndex = (virtualAddr >> PDPT_SHIFT) & 0x1FFn;
    const pdIndex = (virtualAddr >> PD_SHIFT) & 0x1FFn;
    const ptIndex = (virtualAddr >> PT_SHIFT) & 0x1FFn;
    const pageOffset = virtualAddr & OFFSET_MASK;
    
    try {
        // Walk PML4
        const pml4Base = Number(cr3 & PTE_PFN_MASK);
        const pml4EntryOffset = pml4Base + Number(pml4Index * 8n);
        if (pml4EntryOffset + 8 > buffer.byteLength) return null;
        
        const pml4Entry = view.getBigUint64(pml4EntryOffset, true);
        if (!(pml4Entry & PTE_VALID)) return null;
        
        // Walk PDPT
        const pdptBase = Number(pml4Entry & PTE_PFN_MASK);
        const pdptEntryOffset = pdptBase + Number(pdptIndex * 8n);
        if (pdptEntryOffset + 8 > buffer.byteLength) return null;
        
        const pdptEntry = view.getBigUint64(pdptEntryOffset, true);
        if (!(pdptEntry & PTE_VALID)) return null;
        
        // Check for 1GB large page
        if (pdptEntry & PTE_LARGE) {
            const pageBase = pdptEntry & 0x000FFFFC00000000n;
            return pageBase + (virtualAddr & 0x3FFFFFFFn);
        }
        
        // Walk PD
        const pdBase = Number(pdptEntry & PTE_PFN_MASK);
        const pdEntryOffset = pdBase + Number(pdIndex * 8n);
        if (pdEntryOffset + 8 > buffer.byteLength) return null;
        
        const pdEntry = view.getBigUint64(pdEntryOffset, true);
        if (!(pdEntry & PTE_VALID)) return null;
        
        // Check for 2MB large page
        if (pdEntry & PTE_LARGE) {
            const pageBase = pdEntry & 0x000FFFFFFFE00000n;
            return pageBase + (virtualAddr & 0x1FFFFFn);
        }
        
        // Walk PT
        const ptBase = Number(pdEntry & PTE_PFN_MASK);
        const ptEntryOffset = ptBase + Number(ptIndex * 8n);
        if (ptEntryOffset + 8 > buffer.byteLength) return null;
        
        const ptEntry = view.getBigUint64(ptEntryOffset, true);
        if (!(ptEntry & PTE_VALID)) return null;
        
        // Get physical page and add offset
        const physicalPage = ptEntry & PTE_PFN_MASK;
        return physicalPage + pageOffset;
        
    } catch (e) {
        return null;
    }
}

// Stack walking with proper virtual to physical address translation
function walkStackWithTranslation(buffer: ArrayBuffer, context: DumpContext): string[] {
    const results: string[] = [];
    const view = new DataView(buffer);
    
    if (!context.cr3 || !context.rbp || !context.rsp) return results;
    
    let currentRbp = context.rbp;
    let count = 0;
    const maxFrames = 50;
    const visitedAddresses = new Set<string>();
    
    while (currentRbp && count < maxFrames) {
        // Prevent infinite loops
        const rbpKey = currentRbp.toString(16);
        if (visitedAddresses.has(rbpKey)) break;
        visitedAddresses.add(rbpKey);
        
        try {
            // Translate RBP virtual address to physical
            const physicalRbp = virtualToPhysical(buffer, currentRbp, context.cr3);
            if (!physicalRbp) break;
            
            const rbpOffset = Number(physicalRbp);
            if (rbpOffset + 16 > buffer.byteLength) break;
            
            // Read saved RBP and return address
            const savedRbp = view.getBigUint64(rbpOffset, true);
            const returnAddr = view.getBigUint64(rbpOffset + 8, true);
            
            // Validate the return address looks reasonable
            if (isKernelAddress(returnAddr) || isUserAddress(returnAddr)) {
                // Try to find symbol for this address
                const symbol = findSymbolForAddress(buffer, returnAddr, context.cr3);
                if (symbol) {
                    results.push(symbol);
                } else {
                    results.push(`0x${returnAddr.toString(16).padStart(16, '0')}`);
                }
            }
            
            // Move to next frame
            currentRbp = savedRbp;
            count++;
            
        } catch (e) {
            break;
        }
    }
    
    return results;
}

// Check if address is in kernel space
function isKernelAddress(addr: bigint): boolean {
    // Windows x64 kernel addresses start at 0xFFFF800000000000
    return addr >= 0xFFFF800000000000n;
}

// Check if address is in user space
function isUserAddress(addr: bigint): boolean {
    // User space is below 0x00007FFFFFFFFFFF
    return addr > 0x10000n && addr <= 0x00007FFFFFFFFFFFn;
}

// Try to find symbol name for an address
function findSymbolForAddress(buffer: ArrayBuffer, address: bigint, cr3: bigint): string | null {
    // First try to translate the address region to physical
    const physAddr = virtualToPhysical(buffer, address & ~0xFFFn, cr3);
    if (!physAddr) return null;
    
    const offset = Number(physAddr);
    const searchRange = 0x2000; // Search 8KB around
    
    // Look for module and function names near the address
    const symbols = scanForSymbols(buffer, Math.max(0, offset - searchRange), Math.min(buffer.byteLength, offset + searchRange));
    
    // Find closest symbol before our address
    let bestSymbol: string | null = null;
    let bestDistance = BigInt(searchRange);
    
    for (const sym of symbols) {
        if (sym.virtualAddr && sym.virtualAddr <= address) {
            const distance = address - sym.virtualAddr;
            if (distance < bestDistance) {
                bestDistance = distance;
                bestSymbol = sym.name;
                if (distance > 0n) {
                    bestSymbol += `+0x${distance.toString(16)}`;
                }
            }
        }
    }
    
    return bestSymbol;
}

// Scan buffer region for symbol names
function scanForSymbols(buffer: ArrayBuffer, start: number, end: number): Array<{name: string, virtualAddr?: bigint}> {
    const symbols: Array<{name: string, virtualAddr?: bigint}> = [];
    const bytes = new Uint8Array(buffer);
    const chunk = bytes.slice(start, end);
    const text = new TextDecoder('ascii', { fatal: false }).decode(chunk);
    
    // Common patterns for symbols
    const patterns = [
        new RegExp('([A-Za-z_][A-Za-z0-9_]+)!([A-Za-z_][A-Za-z0-9_]+)', 'g'),  // module!function
        new RegExp('nt!([A-Za-z_][A-Za-z0-9_]+)', 'g'),                        // kernel functions
        new RegExp('([A-Za-z0-9_]+\\.sys)', 'g'),                              // driver names
    ];
    
    for (const pattern of patterns) {
        const matches = text.matchAll(pattern);
        for (const match of matches) {
            if (match[0].length >= 4 && match[0].length <= 100) {
                symbols.push({ name: match[0] });
            }
        }
    }
    
    return symbols;
}

// Original simplified stack walking (fallback when no page tables available)
function walkStack(buffer: ArrayBuffer, rbp: bigint): string[] {
    const results: string[] = [];
    const view = new DataView(buffer);
    let currentRbp = rbp;
    let count = 0;
    
    // Common kernel address ranges (simplified)
    const isKernelAddress = (addr: bigint): boolean => {
        return addr >= BigInt('0xFFFFF80000000000') || 
               (addr >= BigInt('0x80000000') && addr <= BigInt('0xFFFFFFFF'));
    };
    
    while (currentRbp && count < 20) {
        try {
            // Try to find the RBP value in the buffer (simplified search)
            // In reality, we'd need virtual to physical address mapping
            const searchValue = Number(currentRbp & BigInt('0xFFFFFFFF'));
            let found = false;
            
            // Search for potential stack frame
            for (let offset = 0; offset < buffer.byteLength - 16; offset += 8) {
                try {
                    const testRbp = view.getBigUint64(offset, true);
                    if (testRbp === currentRbp) {
                        // Found potential stack frame
                        const savedRbp = view.getBigUint64(offset, true);
                        const returnAddr = view.getBigUint64(offset + 8, true);
                        
                        if (isKernelAddress(returnAddr)) {
                            // Try to find symbol name nearby
                            const symbol = findNearbySymbol(buffer, offset);
                            if (symbol) {
                                results.push(symbol);
                            } else {
                                results.push(`0x${returnAddr.toString(16)}`);
                            }
                            
                            currentRbp = savedRbp;
                            found = true;
                            break;
                        }
                    }
                } catch (e) {
                    // Continue searching
                }
            }
            
            if (!found) break;
            count++;
        } catch (e) {
            break;
        }
    }
    
    return results;
}

function findNearbySymbol(buffer: ArrayBuffer, offset: number): string | null {
    const bytes = new Uint8Array(buffer);
    const searchRange = 1024; // Search 1KB around the offset
    const start = Math.max(0, offset - searchRange);
    const end = Math.min(buffer.byteLength, offset + searchRange);
    
    const chunk = bytes.slice(start, end);
    const text = new TextDecoder('ascii', { fatal: false }).decode(chunk);
    
    // Look for common kernel function patterns
    const match = text.match(/([A-Za-z][A-Za-z0-9_]+)!([\w]+)/);
    if (match) {
        return match[0];
    }
    
    return null;
}

function extractPatterns(buffer: ArrayBuffer): string[] {
    const results: string[] = [];
    const bytes = new Uint8Array(buffer);
    const text = new TextDecoder('ascii', { fatal: false }).decode(bytes.slice(0, Math.min(bytes.length, 131072)));
    
    // Patterns for kernel functions
    const patterns = [
        new RegExp('nt![A-Za-z][A-Za-z0-9_]+', 'g'),
        new RegExp('hal![A-Za-z][A-Za-z0-9_]+', 'g'),
        new RegExp('win32k(full|base)?![A-Za-z][A-Za-z0-9_]+', 'g'),
        new RegExp('[A-Za-z][A-Za-z0-9_\\-]+\\.sys(\\+0x[0-9a-fA-F]+)?', 'g'),
        new RegExp('[A-Za-z][A-Za-z0-9_\\-]+![A-Za-z][A-Za-z0-9_]+(\\+0x[0-9a-fA-F]+)?', 'g'),
    ];
    
    // Priority keywords
    const keywords = ['KeBugCheckEx', 'KeBugCheck', 'KiPageFault', 'KiSystemServiceCopyEnd'];
    
    // Extract all matches
    for (const pattern of patterns) {
        const matches = text.matchAll(pattern);
        for (const match of matches) {
            const frame = match[0];
            if (!results.includes(frame) && frame.length > 3) {
                results.push(frame);
            }
        }
    }
    
    // Sort by relevance
    return results.sort((a, b) => {
        // Prioritize frames with keywords
        const aHasKeyword = keywords.some(k => a.includes(k));
        const bHasKeyword = keywords.some(k => b.includes(k));
        if (aHasKeyword && !bHasKeyword) return -1;
        if (!aHasKeyword && bHasKeyword) return 1;
        
        // Prioritize kernel functions
        const aIsKernel = a.startsWith('nt!') || a.startsWith('hal!');
        const bIsKernel = b.startsWith('nt!') || b.startsWith('hal!');
        if (aIsKernel && !bIsKernel) return -1;
        if (!aIsKernel && bIsKernel) return 1;
        
        return 0;
    }).slice(0, 30);
}

/**
 * Enhanced stack extraction with symbol resolution
 */
export function extractStackFramesWithSymbols(
    buffer: ArrayBuffer, 
    context: DumpContext | null, 
    symbolResolver: SymbolResolver,
    moduleList: Array<{ name: string; baseAddress: number; size: number }>
): string[] {
    // First register all modules with the symbol resolver
    for (const module of moduleList) {
        symbolResolver.registerModule(
            module.baseAddress,
            module.size,
            module.name
        );
    }

    // Extract raw addresses first
    const rawFrames = extractStackFrames(buffer, context);
    const resolvedFrames: string[] = [];

    // Try to parse addresses from raw frames and resolve them
    for (const frame of rawFrames) {
        // Check if it's already a symbol (contains '!')
        if (frame.includes('!')) {
            resolvedFrames.push(frame);
            continue;
        }

        // Try to parse as hex address
        const match = frame.match(/^0x([0-9a-fA-F]+)$/);
        if (match) {
            const address = parseInt(match[1], 16);
            const resolved = symbolResolver.resolve(address);
            resolvedFrames.push(resolved.formatted);
        } else {
            resolvedFrames.push(frame);
        }
    }

    // If we have context, do a more thorough stack walk
    if (context && context.rsp && symbolResolver) {
        const additionalFrames = enhancedStackWalk(buffer, context, symbolResolver);
        for (const frame of additionalFrames) {
            if (!resolvedFrames.includes(frame)) {
                resolvedFrames.push(frame);
            }
        }
    }

    return resolvedFrames;
}

/**
 * Enhanced stack walking with better address resolution
 */
function enhancedStackWalk(
    buffer: ArrayBuffer, 
    context: DumpContext, 
    symbolResolver: SymbolResolver
): string[] {
    const results: string[] = [];
    const view = new DataView(buffer);
    
    // Common x64 return address patterns
    const isLikelyReturnAddress = (addr: bigint): boolean => {
        // Kernel addresses
        if (addr >= 0xFFFFF80000000000n && addr <= 0xFFFFFFFFFFFFFFFFn) return true;
        // User mode system DLLs
        if (addr >= 0x00007FF000000000n && addr <= 0x00007FFFFFFFFFFFn) return true;
        return false;
    };

    // Scan stack memory region for potential return addresses
    if (context.rsp) {
        const stackStart = Number(context.rsp & 0xFFFFFFFFn);
        const stackSize = 0x10000; // Scan 64KB of stack
        
        for (let offset = 0; offset < buffer.byteLength - 8; offset += 8) {
            try {
                const value = view.getBigUint64(offset, true);
                
                if (isLikelyReturnAddress(value)) {
                    // Check if this looks like a return address by examining the preceding bytes
                    if (offset >= 5) {
                        const prevBytes = new Uint8Array(buffer, offset - 5, 5);
                        // Look for CALL instruction patterns (E8 = near call, FF 15 = far call)
                        if (prevBytes[4] === 0xE8 || (prevBytes[3] === 0xFF && prevBytes[4] === 0x15)) {
                            const resolved = symbolResolver.resolve(Number(value));
                            if (resolved.module !== 'unknown' && results.length < 50) {
                                results.push(resolved.formatted);
                            }
                        }
                    }
                }
            } catch (e) {
                // Continue on error
            }
        }
    }

    return results;
}