// Improved dump parser with accurate bug check extraction
// This addresses the hallucination issues in the current implementation

import { MinidumpParser } from './minidumpStreams.js';
import { BUG_CHECK_CODES } from './dumpParser.js';

interface BugCheckData {
    code: number;
    parameter1: bigint;
    parameter2: bigint;
    parameter3: bigint;
    parameter4: bigint;
}

// Accurate bug check extraction for PAGEDU64 dumps
export function extractPagedu64BugCheck(view: DataView): BugCheckData | null {
    try {
        // Verify PAGEDU64 signature
        const sig = new TextDecoder().decode(new Uint8Array(view.buffer, 0, 8));
        if (!sig.startsWith('PAGEDU64')) {
            return null;
        }
        
        // Bug check data is at fixed offsets in PAGEDU64
        // Reference: Windows Internals and WinDbg source
        const bugCheckCode = view.getUint32(0x40, true);
        
        // Validate it's a real bug check code
        if (!isValidBugCheckCode(bugCheckCode)) {
            return null;
        }
        
        // Parameters are 64-bit values following the code
        return {
            code: bugCheckCode,
            parameter1: view.getBigUint64(0x48, true),
            parameter2: view.getBigUint64(0x50, true),
            parameter3: view.getBigUint64(0x58, true),
            parameter4: view.getBigUint64(0x60, true)
        };
    } catch (e) {
        console.error('Failed to extract PAGEDU64 bug check:', e);
        return null;
    }
}

// Accurate bug check extraction for minidumps
export function extractMinidumpBugCheck(buffer: ArrayBuffer): BugCheckData | null {
    try {
        const parser = new MinidumpParser(buffer);
        const exception = parser.getException();
        
        if (!exception) {
            return null;
        }
        
        // For kernel dumps, bug check is stored in exception information
        // when exception code is STATUS_BREAKPOINT (0x80000003)
        if (exception.exceptionCode === 0x80000003 && exception.exceptionInformation.length >= 5) {
            const bugCheckCode = Number(exception.exceptionInformation[0]);
            
            if (!isValidBugCheckCode(bugCheckCode)) {
                return null;
            }
            
            return {
                code: bugCheckCode,
                parameter1: exception.exceptionInformation[1] || 0n,
                parameter2: exception.exceptionInformation[2] || 0n,
                parameter3: exception.exceptionInformation[3] || 0n,
                parameter4: exception.exceptionInformation[4] || 0n
            };
        }
        
        return null;
    } catch (e) {
        console.error('Failed to extract minidump bug check:', e);
        return null;
    }
}

// Validate bug check codes against known Windows values
function isValidBugCheckCode(code: number): boolean {
    // Check against known bug check codes
    if (BUG_CHECK_CODES[code]) {
        return true;
    }
    
    // Additional validation for special ranges
    if (code >= 0x1 && code <= 0x1FF) return true;  // Standard range
    if (code >= 0x1000 && code <= 0x1FFF) return true;  // Extended range
    if (code >= 0xC0000000 && code <= 0xC0FFFFFF) return true;  // STATUS codes
    if (code === 0xDEADDEAD) return true;  // Manual crash
    
    return false;
}

// Extract real module names from dump
export function extractRealModules(buffer: ArrayBuffer): string[] {
    const modules: string[] = [];
    const view = new DataView(buffer);
    
    try {
        // For minidumps, use the module list stream
        if (isMinidump(buffer)) {
            const parser = new MinidumpParser(buffer);
            const moduleList = parser.getModules();
            
            return moduleList.map(m => m.name).filter(name => {
                // Filter out suspicious names
                return !isFakeDriver(name) && isValidModuleName(name);
            });
        }
        
        // For kernel dumps, scan for PE headers and extract names
        const peModules = scanForPEModules(buffer);
        return peModules.filter(name => !isFakeDriver(name) && isValidModuleName(name));
        
    } catch (e) {
        console.error('Failed to extract modules:', e);
        return [];
    }
}

function isMinidump(buffer: ArrayBuffer): boolean {
    if (buffer.byteLength < 4) return false;
    const sig = new DataView(buffer).getUint32(0, true);
    return sig === 0x504D444D; // 'MDMP'
}

function isFakeDriver(name: string): boolean {
    const fakeDrivers = [
        'wXr.sys', 'wEB.sys', 'vS.sys', 'xWr.sys',
        'unknown.sys', 'obfuscated.sys'
    ];
    
    return fakeDrivers.some(fake => 
        name.toLowerCase() === fake.toLowerCase()
    );
}

function isValidModuleName(name: string): boolean {
    // Valid module names have specific patterns
    if (!name.match(/^[a-zA-Z0-9_\-]+\.(sys|dll|exe)$/i)) {
        return false;
    }
    
    // Should not be too short or too long
    if (name.length < 5 || name.length > 64) {
        return false;
    }
    
    // Should not contain suspicious patterns
    if (name.match(/[^\x20-\x7E]/)) {  // Non-printable characters
        return false;
    }
    
    return true;
}

function scanForPEModules(buffer: ArrayBuffer): string[] {
    const modules: string[] = [];
    const view = new DataView(buffer);
    
    // Scan for MZ headers
    for (let offset = 0; offset < buffer.byteLength - 0x1000; offset += 0x1000) {
        if (view.getUint16(offset, true) === 0x5A4D) {  // 'MZ'
            try {
                const name = extractPEModuleName(buffer, offset);
                if (name && !modules.includes(name)) {
                    modules.push(name);
                }
            } catch (e) {
                continue;
            }
        }
    }
    
    return modules;
}

function extractPEModuleName(buffer: ArrayBuffer, peOffset: number): string | null {
    const view = new DataView(buffer);
    
    try {
        // Get PE header offset
        const e_lfanew = view.getUint32(peOffset + 0x3C, true);
        const peHeaderOffset = peOffset + e_lfanew;
        
        // Verify PE signature
        if (view.getUint32(peHeaderOffset, true) !== 0x00004550) {
            return null;
        }
        
        // Parse export directory to find module name
        // This is complex - simplified version would look for strings near PE
        const searchStart = Math.max(0, peOffset - 0x1000);
        const searchEnd = Math.min(buffer.byteLength, peOffset + 0x2000);
        
        // Look for module name patterns
        const bytes = new Uint8Array(buffer, searchStart, searchEnd - searchStart);
        const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        
        const modulePattern = /([a-zA-Z0-9_\-]+\.(sys|dll|exe))/i;
        const match = text.match(modulePattern);
        
        return match ? match[1] : null;
        
    } catch (e) {
        return null;
    }
}

// Generate accurate analysis prompt
export function generateAccurateAnalysisPrompt(bugCheck: BugCheckData | null, modules: string[]): string {
    if (!bugCheck) {
        return 'No valid bug check data found in dump file.';
    }
    
    const bugCheckName = BUG_CHECK_CODES[bugCheck.code] || 'UNKNOWN';
    
    return `
Analyze this Windows crash dump with EXACT data:

BUG CHECK: ${bugCheckName} (0x${bugCheck.code.toString(16).toUpperCase().padStart(8, '0')})
Parameters:
- Param 1: 0x${bugCheck.parameter1.toString(16).toUpperCase().padStart(16, '0')}
- Param 2: 0x${bugCheck.parameter2.toString(16).toUpperCase().padStart(16, '0')}
- Param 3: 0x${bugCheck.parameter3.toString(16).toUpperCase().padStart(16, '0')}
- Param 4: 0x${bugCheck.parameter4.toString(16).toUpperCase().padStart(16, '0')}

Detected Modules: ${modules.join(', ')}

STRICT RULES:
1. Use ONLY the bug check code provided above
2. Use ONLY the module names listed above
3. Do NOT invent any driver names
4. Do NOT create bug check codes
5. Base analysis on Windows documentation for this specific bug check
`;
}