// Enhanced dump file parser for BSOD analysis
// Supports both minidump and full kernel dumps

import { MinidumpParser } from './minidumpStreams.js';
import { validateBugCheckParameters as validateBugCheckParamsImported, analyzeBugCheckParameters, DumpValidator } from './dumpValidator.js';
import { parseKernelDumpHeader } from './kernelDumpModuleParser.js';
import { BUG_CHECK_CODES, bugCheckName } from './bugCheckCodes.js';

export { BUG_CHECK_CODES };

export interface FileValidationResult {
    isValid: boolean;
    fileType?: string;
    error?: string;
}

export interface DumpHeader {
    signature: string;
    majorVersion?: number;
    minorVersion?: number;
    machineImageType?: number;
    directoryTableBase?: bigint;  // CR3 for virtual to physical translation
    pfnDatabase?: bigint;
    psLoadedModuleList?: bigint;
    physicalMemoryRuns?: Array<{basePage: bigint; pageCount: bigint}>;
    version?: number;
    streamCount?: number;
    streamDirectory?: number;
    checksum?: number;
    timestamp?: Date;
}

export interface ExceptionInfo {
    code: number;
    name: string;
    address: bigint;
    parameter1: bigint;
    parameter2: bigint;
    threadId?: number;
    flags?: number;
}

export interface ModuleInfo {
    name: string;
    base: bigint;
    size: number;
    timestamp?: number;
    checksum?: number;
}

export interface ThreadContext {
    threadId: number;
    rip?: bigint;  // Instruction pointer
    rsp?: bigint;  // Stack pointer
    rbp?: bigint;  // Base pointer
    cr3?: bigint;  // Page table base (from dump header)
    lastError?: number;
    priority?: number;
}

export interface StructuredDumpInfo {
    dumpHeader: DumpHeader | null;
    exceptionInfo: ExceptionInfo | null;
    moduleList: ModuleInfo[];
    threadContext: ThreadContext | null;
    bugCheckInfo: BugCheckInfo | null;
}

export interface BugCheckInfo {
    code: number;
    name: string;
    parameter1: bigint;
    parameter2: bigint;
    parameter3: bigint;
    parameter4: bigint;
    validation?: {
        valid: boolean;
        errors: string[];
        description?: string;
    };
    analysis?: {
        analysis: string;
        severity: 'critical' | 'high' | 'medium' | 'low';
        likelyCauses: string[];
    };
}

// Common Windows exception codes
const EXCEPTION_CODES: Record<number, string> = {
    0x80000003: 'BREAKPOINT',
    0xC0000005: 'ACCESS_VIOLATION',
    0xC0000008: 'INVALID_HANDLE',
    0xC000001D: 'ILLEGAL_INSTRUCTION',
    0xC0000025: 'NONCONTINUABLE_EXCEPTION',
    0xC00000FD: 'STACK_OVERFLOW',
    0xC0000026: 'INVALID_DISPOSITION',
    0xC0000094: 'INTEGER_DIVIDE_BY_ZERO',
    0xC0000095: 'INTEGER_OVERFLOW',
    0xC0000096: 'PRIVILEGED_INSTRUCTION',
    0xC00000FE: 'MULTIPLE_FAULT_VIOLATION',
    0xC0000194: 'POSSIBLE_DEADLOCK',
    0xC0000409: 'FAST_FAIL',
};

export function validateDumpFile(buffer: ArrayBuffer, _filename: string): FileValidationResult {
    if (buffer.byteLength < 32) {
        return {
            isValid: false,
            error: `File is too small to be a valid dump file (${buffer.byteLength} bytes)`
        };
    }
    
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    
    // Check for known dump file signatures
    // PAGEDUMP signature (full/kernel dumps) - can be "PAGEDUMP" or "PAGEDU64"
    if (bytes[0] === 0x50 && bytes[1] === 0x41 && bytes[2] === 0x47 && bytes[3] === 0x45 &&
        bytes[4] === 0x44 && bytes[5] === 0x55) {
        // Check for both PAGEDUMP and PAGEDU64
        if ((bytes[6] === 0x4D && bytes[7] === 0x50) || // "MP" for PAGEDUMP
            (bytes[6] === 0x36 && bytes[7] === 0x34)) { // "64" for PAGEDU64
            return { isValid: true, fileType: 'PAGEDUMP' };
        }
    }
    
    // Alternative PAGEDUMP format (4-byte chunks)
    const sig1 = view.getUint32(0, true);
    const sig2 = view.getUint32(4, true);
    if (sig1 === 0x45474150 && sig2 === 0x504D5544) { // "PAGE" "DUMP"
        return { isValid: true, fileType: 'PAGEDUMP' };
    }
    
    // MINIDUMP signature
    if (sig1 === 0x504D444D) { // "MDMP"
        return { isValid: true, fileType: 'MINIDUMP' };
    }
    
    // Legacy DUMP format
    if (sig1 === 0x44554D50) { // "DUMP"
        return { isValid: true, fileType: 'DUMP' };
    }
    
    // Check for common non-dump file signatures
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
        bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) {
        return {
            isValid: false,
            fileType: 'PNG',
            error: 'This is a PNG image file, not a Windows crash dump. Please upload actual .dmp files from C:\\Windows\\Minidump\\'
        };
    }
    
    if (bytes[0] === 0x4D && bytes[1] === 0x5A) { // "MZ"
        return {
            isValid: false,
            fileType: 'EXE',
            error: 'This is a Windows executable file, not a crash dump'
        };
    }
    
    if (bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04) {
        return {
            isValid: false,
            fileType: 'ZIP',
            error: 'This appears to be a ZIP archive. Please extract the .dmp files first'
        };
    }
    
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) { // "%PDF"
        return {
            isValid: false,
            fileType: 'PDF',
            error: 'This is a PDF document, not a crash dump file'
        };
    }
    
    if ((bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) &&
        (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) { // "GIF87a" or "GIF89a"
        return {
            isValid: false,
            fileType: 'GIF',
            error: 'This is a GIF image file, not a crash dump'
        };
    }
    
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
        return {
            isValid: false,
            fileType: 'JPEG',
            error: 'This is a JPEG image file, not a crash dump. Screenshots cannot be analyzed - please upload actual .dmp files'
        };
    }
    
    // Unknown format - show hex preview
    const hexPreview = Array.from(bytes.slice(0, 32))
        .map(b => b.toString(16).padStart(2, '0'))
        .join(' ');
    
    return {
        isValid: false,
        error: `Unknown file format. First 32 bytes: ${hexPreview}. Valid dump files have extensions like .dmp, .mdmp, .hdmp, or .kdmp`
    };
}

export function extractDumpHeader(buffer: ArrayBuffer): DumpHeader | null {
    if (buffer.byteLength < 32) return null;
    
    const view = new DataView(buffer);
    
    // Check for PAGEDUMP signature (full/kernel dumps)
    const sig1 = view.getUint32(0, true);
    if (sig1 === 0x45474150) { // "PAGE"
        const sig2 = view.getUint32(4, true);
        if (sig2 === 0x504D5544) { // "DUMP" (32-bit DUMP_HEADER)
            return extractPageDumpHeader(view, false);
        }
        if (sig2 === 0x34365544) { // "DU64" (DUMP_HEADER64)
            return extractPageDumpHeader(view, true);
        }
    }
    
    // Check for minidump signature
    if (sig1 === 0x504D444D) { // "MDMP"
        return extractMinidumpHeader(view);
    }
    
    // Check for older dump formats
    if (sig1 === 0x44554D50) { // "DUMP"
        return extractLegacyDumpHeader(view);
    }
    
    return null;
}

function extractPageDumpHeader(view: DataView, is64: boolean): DumpHeader {
    // The comprehensive parser handles DUMP_HEADER64 (PAGEDU64) only
    if (is64) {
        try {
            const kernelHeader = parseKernelDumpHeader(view.buffer as ArrayBuffer);
            if (kernelHeader) {
                const header: DumpHeader = {
                    signature: kernelHeader.signature,
                    majorVersion: kernelHeader.majorVersion,
                    minorVersion: kernelHeader.minorVersion,
                    machineImageType: kernelHeader.machineImageType,
                    directoryTableBase: kernelHeader.directoryTableBase,
                    pfnDatabase: kernelHeader.pfnDatabase,
                    psLoadedModuleList: kernelHeader.psLoadedModuleList,
                };
            
                // Add physical memory runs if available
                if (kernelHeader.physicalMemoryDescriptor) {
                    header.physicalMemoryRuns = kernelHeader.physicalMemoryDescriptor.runs;
                }
            
                return header;
            }
        } catch (e) {
            console.error('Kernel dump parser failed, falling back to basic parsing:', e);
        }
    }
    
    // Fallback to basic parsing. Only the fields with bitness-stable offsets
    // are read here (signature/version @8/12, MachineType @0x20 in the 32-bit
    // header); the PAGEDU64-specific fields (DirectoryTableBase, PfnDataBase,
    // PsLoadedModuleList, physical memory runs) belong to
    // parseKernelDumpHeader in kernelDumpModuleParser.ts, which runs first and
    // uses the canonical DUMP_HEADER64 offsets. This fallback fires only for
    // 32-bit PAGEDUMP dumps and truncated PAGEDU64 files.
    const header: DumpHeader = {
        signature: is64 ? 'PAGEDU64' : 'PAGEDUMP',
        majorVersion: view.getUint32(8, true),
        minorVersion: view.getUint32(12, true),
    };

    // MachineImageType: 0x20 in DUMP_HEADER, 0x30 in DUMP_HEADER64
    const machineTypeOffset = is64 ? 0x30 : 0x20;
    if (view.byteLength >= machineTypeOffset + 4) {
        header.machineImageType = view.getUint32(machineTypeOffset, true);
    }

    return header;
}

function extractMinidumpHeader(view: DataView): DumpHeader {
    const header: DumpHeader = {
        signature: 'MINIDUMP',
        version: view.getUint32(4, true),
        streamCount: view.getUint32(8, true),
        streamDirectory: view.getUint32(12, true),
    };
    
    // Checksum and timestamp
    if (view.byteLength >= 24) {
        header.checksum = view.getUint32(16, true);
        const timestamp = view.getUint32(20, true);
        header.timestamp = new Date(timestamp * 1000);
    }
    
    return header;
}

function extractLegacyDumpHeader(view: DataView): DumpHeader {
    return {
        signature: 'DUMP_LEGACY',
        majorVersion: view.getUint32(4, true),
        minorVersion: view.getUint32(8, true),
    };
}

// Canonical x64 exception-address ranges: the kernel-space high half, or a
// mapped user address. Near-NULL stays rejected — it is indistinguishable from
// an all-zero fabricated record.
function isPlausibleExceptionAddress(address: bigint): boolean {
    if (address >= BigInt('0xFFFF800000000000')) return true; // kernel space
    return address >= BigInt('0x1000') && address < BigInt('0x800000000000'); // user space
}

export function extractExceptionInfo(buffer: ArrayBuffer): ExceptionInfo | null {
    const view = new DataView(buffer);

    // Search for exception codes in the first 64KB. The 64-bit record reads
    // span i..i+48, so the bound must reserve 48 bytes — a looser bound let
    // a hit near the tail throw RangeError and fall into the 32-bit path.
    const searchLimit = Math.min(buffer.byteLength, 65536);

    for (let i = 0; i + 48 <= searchLimit; i += 4) {
        const code = view.getUint32(i, true);

        if (EXCEPTION_CODES[code]) {
            // EXCEPTION_RECORD64: ExceptionCode@+0, ExceptionFlags@+4,
            // ExceptionRecord (link)@+8, ExceptionAddress@+16,
            // NumberParameters@+24, ExceptionInformation[0]@+32, [1]@+40.
            // The old read took the link pointer as the address and
            // NumberParameters as a parameter.
            try {
                const info: ExceptionInfo = {
                    code: code,
                    name: EXCEPTION_CODES[code],
                    address: view.getBigUint64(i + 16, true),
                    parameter1: view.getBigUint64(i + 32, true),
                    parameter2: view.getBigUint64(i + 40, true),
                };

                // Validate the address is in a canonical range (kernel or
                // user space). The old check rejected kernel addresses
                // outright, skipping real records for fabricated ones.
                if (isPlausibleExceptionAddress(info.address)) {
                    return info;
                }
            } catch (e) {
                // Bounds above make this unreachable; keep for safety.
            }

            // 32-bit EXCEPTION_RECORD (x86 dumps): ExceptionCode@+0,
            // ExceptionFlags@+4, ExceptionRecord@+8, ExceptionAddress@+12,
            // NumberParameters@+16, ExceptionInformation[0]@+20, [1]@+24.
            // Tried whenever the 64-bit interpretation fails validation —
            // a dead catch never runs, so this must be an explicit fallback.
            try {
                const info: ExceptionInfo = {
                    code: code,
                    name: EXCEPTION_CODES[code],
                    address: BigInt(view.getUint32(i + 12, true)),
                    parameter1: BigInt(view.getUint32(i + 20, true)),
                    parameter2: BigInt(view.getUint32(i + 24, true)),
                };
                if (isPlausibleExceptionAddress(info.address)) {
                    return info;
                }
            } catch (e) {
                continue;
            }
        }
    }

    return null;
}

// Helper function to validate bug check parameters
function isValidBugCheckCode(code: number): boolean {
    // Any documented code in the shared table (e.g. 0x100000D6) first
    if (Object.prototype.hasOwnProperty.call(BUG_CHECK_CODES, code)) {
        return true;
    }
    
    // Valid bug check codes are typically:
    // - Between 0x01 and 0xFF for standard codes
    // - Between 0x100 and 0x1FF for extended codes
    // - Some special codes in 0x1000+ range
    // - Some codes in 0xC0000000+ range (STATUS codes used as bug checks)
    return (code > 0 && code <= 0xFF) ||
           (code >= 0x100 && code <= 0x1FF) ||
           (code >= 0x1000 && code <= 0x10000) ||
           (code >= 0xC0000000 && code <= 0xC0FFFFFF) ||
           (code >= 0x4000008A && code <= 0x40000100) ||
           code === 0xDEADDEAD || code === 0x0000DEAD;
}

// Helper to validate parameters based on bug check code
function validateBugCheckParamsBasic(code: number, p1: number, p2: number, p3: number, p4: number): boolean {
    // Special validation for known bug check codes
    switch (code) {
        case 0x1E: // KMODE_EXCEPTION_NOT_HANDLED
            // P1 is the exception code: an error NTSTATUS, or a facility-0
            // warning such as 0x80000002 DATATYPE_MISALIGNMENT (documented),
            // 0x80000003 BREAKPOINT or 0x80000004 SINGLE_STEP
            return (p1 >= 0xC0000000 && p1 <= 0xC0FFFFFF) || (p1 >= 0x80000001 && p1 <= 0x8000FFFF);

        case 0xE2: // MANUALLY_INITIATED_CRASH: no parameters
        case 0xDEADDEAD: // MANUALLY_INITIATED_CRASH1: four reserved parameters
            // Normally all zero, so the default non-zero check would drop them
            return true;
            
        case 0x7E: // SYSTEM_THREAD_EXCEPTION_NOT_HANDLED
            // P2 is the faulting instruction address (kernel space)
            return p2 === 0 || p2 > 0x80000000;

        case 0xA: // IRQL_NOT_LESS_OR_EQUAL
        case 0xD1: // DRIVER_IRQL_NOT_LESS_OR_EQUAL
            // P2 is the IRQL at the time of the fault (0..31)
            return p2 < 0x20;

        case 0x50: // PAGE_FAULT_IN_NONPAGED_AREA
            // P2 is the access type (0 read, 2 write, 0x10 execute; 1/8 on Arm or before 1507): no
            // address constraint applies
            return true;
            
        case 0x133: // DPC_WATCHDOG_VIOLATION
            // P1 is 0 or 1, P2 is timeout value
            return (p1 === 0 || p1 === 1) && p2 > 0;
            
        case 0x124: // WHEA_UNCORRECTABLE_ERROR
            // P1 is the error source type (0x0..0x12 documented)
            return p1 >= 0 && p1 <= 0x12;
            
        default:
            // For unknown codes, at least one parameter should be non-zero
            // and not all 0xFFFFFFFF
            return (p1 !== 0 || p2 !== 0 || p3 !== 0 || p4 !== 0) &&
                   !(p1 === 0xFFFFFFFF && p2 === 0xFFFFFFFF && p3 === 0xFFFFFFFF && p4 === 0xFFFFFFFF);
    }
}

// Helper function to create BugCheckInfo with validation
function createBugCheckInfo(code: number, p1: bigint, p2: bigint, p3: bigint, p4: bigint): BugCheckInfo {
    const params = [p1, p2, p3, p4];
    const validation = validateBugCheckParamsImported(code, params);
    const analysis = analyzeBugCheckParameters(code, params);
    
    return {
        code,
        name: bugCheckName(code),
        parameter1: p1,
        parameter2: p2,
        parameter3: p3,
        parameter4: p4,
        validation,
        analysis
    };
}

export function extractBugCheckInfo(buffer: ArrayBuffer): BugCheckInfo | null {
    const view = new DataView(buffer);
    console.log('[BugCheck] Starting bug check extraction, buffer size:', buffer.byteLength);

    // Strategy 0: structured kernel dump headers. A PAGEDU64/PAGEDUMP header
    // is the only bug check evidence in a kernel dump: when its code fails
    // validation the answer is null, never a scan of the header bytes (which
    // fabricated codes such as 0x4A61 from the build number, issue #188).
    if (buffer.byteLength >= 0x2000) {
        const sig1 = view.getUint32(0, true);
        const sig2 = view.getUint32(4, true);

        // PAGEDU64 (DUMP_HEADER64): BugCheckCode @0x38, ULONG64 parameters @0x40-0x58.
        if (sig1 === 0x45474150 && sig2 === 0x34365544) { // 'PAGE' 'DU64'
            console.log('[BugCheck] Detected PAGEDU64 format');
            const code = view.getUint32(0x38, true);
            if (!isValidBugCheckCode(code)) return null;
            return createBugCheckInfo(
                code,
                view.getBigUint64(0x40, true),
                view.getBigUint64(0x48, true),
                view.getBigUint64(0x50, true),
                view.getBigUint64(0x58, true)
            );
        }

        // PAGEDUMP (32-bit DUMP_HEADER): BugCheckCode @0x28, ULONG parameters
        // @0x2C-0x38. 0x3C onward is the VersionUser ASCII text.
        if (sig1 === 0x45474150 && sig2 === 0x504D5544) { // 'PAGE' 'DUMP'
            console.log('[BugCheck] Detected PAGEDUMP format');
            const code = view.getUint32(0x28, true);
            if (!isValidBugCheckCode(code)) return null;
            return createBugCheckInfo(
                code,
                BigInt(view.getUint32(0x2C, true)),
                BigInt(view.getUint32(0x30, true)),
                BigInt(view.getUint32(0x34, true)),
                BigInt(view.getUint32(0x38, true))
            );
        }
    }

    // Strategy 1: Parse MINIDUMP format (very common)
    if (buffer.byteLength >= 0x1000) {
        const sig = view.getUint32(0, true);
        if (sig === 0x504D444D) { // 'MDMP'
            // Use comprehensive minidump parser
            try {
                const parser = new MinidumpParser(buffer);
                const bugCheckData = parser.getBugCheckInfo();

                if (bugCheckData) {
                    const [bp1, bp2, bp3, bp4] = bugCheckData.parameters;
                    if (validateBugCheckParamsBasic(bugCheckData.code, Number(bp1), Number(bp2), Number(bp3), Number(bp4))) {
                        console.log(`[BugCheck] Found via MinidumpParser: 0x${bugCheckData.code.toString(16).padStart(8, '0')} (${BUG_CHECK_CODES[bugCheckData.code] || 'UNKNOWN'})`);
                        return createBugCheckInfo(
                            bugCheckData.code,
                            bp1 || 0n,
                            bp2 || 0n,
                            bp3 || 0n,
                            bp4 || 0n
                        );
                    }
                    console.log('[BugCheck] MinidumpParser bug check failed parameter validation, ignoring');
                }
            } catch (e) {
                console.log('[BugCheck] MinidumpParser failed:', e);
            }
            // No legacy fallback: re-reading ExceptionInformation without
            // NumberParameters and as truncated uint32s turned user-mode
            // breakpoints into fabricated STOP codes (issue #189).
        }
    }

    // No structured header and no exception-stream convention: there is no
    // evidence-based bug check. The KiBug-anchor, STOP-text and unanchored
    // uint32 scans that used to run here fabricated codes from header fields
    // (the build number), stray text and arbitrary words (issues #106, #188).
    return null;
}

// Helper function to validate module names and filter out AI hallucinations
export function isLegitimateModuleName(name: string): boolean {
    // Reject known fake drivers that AI hallucinates
    const fakeDrivers = [
        'wxr.sys', 'web.sys', 'vs.sys', 'xxx.sys', 'test.sys',
        'unknown.sys', 'fake.sys', 'temp.sys', 'dummy.sys'
    ];
    
    const lowerName = name.toLowerCase();
    if (fakeDrivers.includes(lowerName)) {
        console.warn(`[Validation] Rejected fake driver: ${name}`);
        return false;
    }
    
    // Must match Windows module naming patterns
    if (!/^[a-zA-Z0-9_\-]+\.(sys|dll|exe)$/i.test(name)) {
        return false;
    }
    
    // Must be reasonable length
    if (name.length < 4 || name.length > 64) {
        return false;
    }
    
    return true;
}

function extractNearbyString(buffer: ArrayBuffer, offset: number, range: number): string | null {
    const bytes = new Uint8Array(buffer);
    const start = Math.max(0, offset - range);
    const end = Math.min(bytes.length, offset + range);
    let current = '';
    let best = '';
    for (let i = start; i < end; i++) {
        const b = bytes[i];
        if (b >= 0x20 && b < 0x7F) {
            current += String.fromCharCode(b);
        } else {
            if (current.length > best.length && /\.(sys|dll|exe)/i.test(current)) {
                best = current;
            }
            current = '';
        }
    }
    if (current.length > best.length && /\.(sys|dll|exe)/i.test(current)) {
        best = current;
    }
    return best || null;
}

// Upper bound on the printable-string text extractModuleList scans (#153).
const MODULE_SCAN_MAX_CHARS = 256 * 1024;

export function extractModuleList(buffer: ArrayBuffer, strings: string): ModuleInfo[] {
    const modules: ModuleInfo[] = [];
    const seen = new Set<string>();
    
    // First try minidump module stream for accurate data
    const view = new DataView(buffer);
    if (view.getUint32(0, true) === 0x504D444D) { // MDMP
        try {
            const parser = new MinidumpParser(buffer);
            const minidumpModules = parser.getModules();
            
            for (const mod of minidumpModules) {
                if (isLegitimateModuleName(mod.name) && !seen.has(mod.name.toLowerCase())) {
                    seen.add(mod.name.toLowerCase());
                    modules.push({
                        name: mod.name,
                        base: BigInt(mod.baseAddress),
                        size: mod.size,
                        timestamp: mod.timestamp,
                        checksum: mod.checksum
                    });
                }
            }
            
            if (modules.length > 0) {
                console.log(`[Modules] Found ${modules.length} modules via minidump parser`);
                return modules;
            }
        } catch (e) {
            console.log('[Modules] Minidump module extraction failed:', e);
        }
    }
    
    // Enhanced patterns for better module detection. These run on the main
    // thread over strings extracted from an untrusted dump, so every quantifier
    // is bounded and a bare name may only start at an identifier boundary,
    // which keeps each scan linear. The unbounded forms ([...]+\.(sys|dll|exe),
    // (\w+\s+\w+)?\s*-, [^...]+\\) backtracked quadratically over long
    // identifier, whitespace or path runs and could hang the tab (issue #153).
    // The 60-character stem cap matches isLegitimateModuleName's 64-character
    // limit on the full name.
    const modulePatterns = [
        // Standard module names
        new RegExp('(?<![a-zA-Z0-9_\\-])([a-zA-Z0-9_\\-]{1,60}\\.(sys|dll|exe))', 'gi'),
        // Module with version info
        new RegExp('(?<![a-zA-Z0-9_\\-])([a-zA-Z0-9_\\-]{1,60}\\.(sys|dll|exe))\\s{1,16}\\d{1,10}\\.\\d{1,10}\\.\\d{1,10}\\.\\d{1,10}', 'gi'),
        // Module with company name
        new RegExp('(?<!\\w)(\\w{1,64}\\s{1,8}\\w{1,64})?\\s{0,8}-\\s{0,8}([a-zA-Z0-9_][a-zA-Z0-9_\\-]{0,59}\\.(sys|dll|exe))', 'gi'),
        // Full path modules: backslash-separated segments, so the split between
        // directory and file name is never ambiguous
        new RegExp('[A-Z]:\\\\(?:[^"<>|?*\\n\\r\\\\]{1,255}\\\\){0,32}([a-zA-Z0-9_\\-]{1,60}\\.(sys|dll|exe))', 'gi'),
        // System32 modules
        new RegExp('system32\\\\([a-zA-Z0-9_\\-]{1,60}\\.(sys|dll|exe))', 'gi')
    ];
    // The prompt carries only the first MAX_STRINGS_LENGTH (25,000 chars) of
    // these strings; the module scan looks further, bounded at 256 KB so the
    // work stays small on a 5 MB dump.
    const scanned = strings.length > MODULE_SCAN_MAX_CHARS ? strings.slice(0, MODULE_SCAN_MAX_CHARS) : strings;
    
    // First pass: Extract all module names
    for (const pattern of modulePatterns) {
        const matches = scanned.matchAll(pattern);
        for (const match of matches) {
            // Extract just the filename
            let name = match[match.length - 1] || match[1];
            if (name.includes('\\')) {
                name = name.substring(name.lastIndexOf('\\') + 1);
            }
            name = name.toLowerCase();
            
            // Filter out common false positives and validate
            if (!seen.has(name) && 
                !name.includes('...') &&
                isLegitimateModuleName(name)) {
                seen.add(name);
                modules.push({
                    name: name,
                    base: 0n,
                    size: 0,
                });
            }
            
            if (modules.length >= 100) break;
        }
    }
    
    // Second pass: Prioritize important modules
    modules.sort((a, b) => {
        // System modules first
        const aIsSystem = a.name.startsWith('nt') || a.name.startsWith('hal') || 
                         a.name.includes('kernel') || a.name.startsWith('win32k');
        const bIsSystem = b.name.startsWith('nt') || b.name.startsWith('hal') || 
                         b.name.includes('kernel') || b.name.startsWith('win32k');
        if (aIsSystem && !bIsSystem) return -1;
        if (!aIsSystem && bIsSystem) return 1;
        
        // Then drivers (.sys)
        const aIsDriver = a.name.endsWith('.sys');
        const bIsDriver = b.name.endsWith('.sys');
        if (aIsDriver && !bIsDriver) return -1;
        if (!aIsDriver && bIsDriver) return 1;
        
        return 0;
    });
    
    // Try to extract module info from binary structures (reuse existing view)
    // const view already declared above
    
    // Look for PE headers (MZ signature)
    for (let i = 0; i < Math.min(buffer.byteLength - 64, 100000); i += 8) {
        if (view.getUint16(i, true) === 0x5A4D) { // "MZ"
            try {
                const e_lfanew = view.getUint32(i + 60, true);
                if (i + e_lfanew + 4 < buffer.byteLength) {
                    const peSignature = view.getUint32(i + e_lfanew, true);
                    if (peSignature === 0x00004550) { // "PE\0\0"
                        // Found a PE header, extract info
                        const timestamp = view.getUint32(i + e_lfanew + 8, true);
                        const sizeOfImage = view.getUint32(i + e_lfanew + 80, true);
                        
                        // Try to find module name nearby
                        const nearbyString = extractNearbyString(buffer, i, 256);
                        if (nearbyString && nearbyString.match(/\.(sys|dll|exe)/i)) {
                            modules.push({
                                name: nearbyString,
                                base: BigInt(i),
                                size: sizeOfImage,
                                timestamp: timestamp,
                            });
                        }
                    }
                }
            } catch (e) {
                continue;
            }
        }
    }
    
    return modules;
}

export function extractThreadContext(buffer: ArrayBuffer): ThreadContext | null {
    const view = new DataView(buffer);
    
    // Look for CONTEXT structure markers
    // x64 CONTEXT starts with P1Home-P6Home (6 * 8 bytes of home space)
    // followed by ContextFlags
    
    for (let i = 0; i < Math.min(buffer.byteLength - 0x500, 65536); i += 8) {
        try {
            // Check for CONTEXT_FULL flag (0x10000b)
            const contextFlags = view.getUint32(i + 48, true);
            if (contextFlags === 0x10000b || contextFlags === 0x10003b) {
                // Found potential CONTEXT structure
                const context: ThreadContext = {
                    threadId: 0, // Would need thread info to determine
                };
                
                // Extract registers (offsets for x64 CONTEXT)
                const ripOffset = i + 0xF8;
                const rspOffset = i + 0x98;
                const rbpOffset = i + 0xA0;
                
                if (ripOffset + 8 <= buffer.byteLength) {
                    context.rip = view.getBigUint64(ripOffset, true);
                    context.rsp = view.getBigUint64(rspOffset, true);
                    context.rbp = view.getBigUint64(rbpOffset, true);
                    
                    // Validate that these look like valid addresses
                    if (context.rip! > 0xFFFF000000000000n && context.rsp! > 0xFFFF000000000000n) {
                        // Try to get CR3 from dump header
                        const header = extractDumpHeader(buffer);
                        if (header && header.directoryTableBase) {
                            context.cr3 = header.directoryTableBase;
                        }
                        return context;
                    }
                }
            }
        } catch (e) {
            continue;
        }
    }
    
    return null;
}

export function getStructuredDumpInfo(buffer: ArrayBuffer, strings: string): StructuredDumpInfo {
    const structuredInfo: StructuredDumpInfo = {
        dumpHeader: extractDumpHeader(buffer),
        exceptionInfo: extractExceptionInfo(buffer),
        bugCheckInfo: extractBugCheckInfo(buffer),
        moduleList: extractModuleList(buffer, strings),
        threadContext: extractThreadContext(buffer),
    };
    
    // Cross-validate the extracted information
    if (structuredInfo.moduleList.length > 0) {
        const moduleValidation = DumpValidator.validateModuleAddresses(structuredInfo.moduleList);
        if (moduleValidation.length > 0) {
            console.warn('Module validation errors:', moduleValidation);
        }
    }
    
    // If this is a minidump, use the comprehensive parser for better accuracy
    const view = new DataView(buffer);
    if (buffer.byteLength >= 32 && view.getUint32(0, true) === 0x504D444D) { // 'MDMP'
        try {
            const parser = new MinidumpParser(buffer);
            
            // Override with more accurate data from MinidumpParser
            const minidumpModules = parser.getModules();
            if (minidumpModules.length > 0) {
                structuredInfo.moduleList = minidumpModules.map(m => ({
                    name: m.name,
                    base: m.baseAddress,
                    size: m.size,
                    timestamp: m.timestamp,
                    checksum: m.checksum,
                }));
            }
            
            const minidumpThreads = parser.getThreads();
            if (minidumpThreads.length > 0 && minidumpThreads[0].instructionPointer !== 0n) {
                structuredInfo.threadContext = {
                    threadId: minidumpThreads[0].threadId,
                    rip: minidumpThreads[0].instructionPointer,
                    rsp: minidumpThreads[0].stackPointer,
                    rbp: minidumpThreads[0].framePointer,
                    cr3: structuredInfo.dumpHeader?.directoryTableBase,
                    priority: minidumpThreads[0].priority,
                };
            }
            
            const minidumpException = parser.getException();
            if (minidumpException) {
                structuredInfo.exceptionInfo = {
                    code: minidumpException.exceptionCode,
                    name: EXCEPTION_CODES[minidumpException.exceptionCode] || 'UNKNOWN_EXCEPTION',
                    address: minidumpException.exceptionAddress,
                    parameter1: minidumpException.exceptionInformation[0] || 0n,
                    parameter2: minidumpException.exceptionInformation[1] || 0n,
                    flags: minidumpException.exceptionFlags,
                };
            }
        } catch (e) {
            console.error('MinidumpParser enhancement failed:', e);
        }
    }
    
    return structuredInfo;
}

// Export alias for compatibility
export { isLegitimateModuleName as isLegitimateDriver };