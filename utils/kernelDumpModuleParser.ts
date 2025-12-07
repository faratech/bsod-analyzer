/**
 * Kernel Dump Module Parser
 * Parses PAGEDU64 Windows kernel crash dumps to extract accurate module information.
 * Based on the DUMP_0x2000 structure that contains module list and strings.
 */

// Bug check code database
export const BUG_CHECK_CODES: Record<number, string> = {
  0x0000000A: "IRQL_NOT_LESS_OR_EQUAL",
  0x0000001A: "MEMORY_MANAGEMENT",
  0x0000001E: "KMODE_EXCEPTION_NOT_HANDLED",
  0x00000024: "NTFS_FILE_SYSTEM",
  0x0000003B: "SYSTEM_SERVICE_EXCEPTION",
  0x00000050: "PAGE_FAULT_IN_NONPAGED_AREA",
  0x0000007E: "SYSTEM_THREAD_EXCEPTION_NOT_HANDLED",
  0x0000007F: "UNEXPECTED_KERNEL_MODE_TRAP",
  0x0000009F: "DRIVER_POWER_STATE_FAILURE",
  0x000000BE: "ATTEMPTED_WRITE_TO_READONLY_MEMORY",
  0x000000C1: "SPECIAL_POOL_DETECTED_MEMORY_CORRUPTION",
  0x000000C2: "BAD_POOL_CALLER",
  0x000000C4: "DRIVER_VERIFIER_DETECTED_VIOLATION",
  0x000000D1: "DRIVER_IRQL_NOT_LESS_OR_EQUAL",
  0x000000EF: "CRITICAL_PROCESS_DIED",
  0x000000F4: "CRITICAL_OBJECT_TERMINATION",
  0x000000FC: "ATTEMPTED_EXECUTE_OF_NOEXECUTE_MEMORY",
  0x00000101: "CLOCK_WATCHDOG_TIMEOUT",
  0x00000109: "CRITICAL_STRUCTURE_CORRUPTION",
  0x0000010E: "VIDEO_MEMORY_MANAGEMENT_INTERNAL",
  0x00000116: "VIDEO_TDR_FAILURE",
  0x00000117: "VIDEO_TDR_TIMEOUT_DETECTED",
  0x00000119: "VIDEO_SCHEDULER_INTERNAL_ERROR",
  0x00000124: "WHEA_UNCORRECTABLE_ERROR",
  0x00000133: "DPC_WATCHDOG_VIOLATION",
  0x00000139: "KERNEL_SECURITY_CHECK_FAILURE",
  0x0000013A: "KERNEL_MODE_HEAP_CORRUPTION",
  0x00000154: "UNEXPECTED_STORE_EXCEPTION",
  0x000001C4: "DRIVER_VERIFIER_DETECTED_VIOLATION_LIVEDUMP",
  0x000001D5: "DRIVER_PNP_WATCHDOG",
};

// DUMP_0x2000 structure offsets for 64-bit dumps
const DUMP_0x2000_OFFSETS = {
  StackRva: 0x0C,       // 4 bytes - offset to stack frames
  LoadedModules: 0x30,  // 4 bytes - offset to module entries
  StringsRva: 0x38,     // 4 bytes - offset to module names
};

// LOADED_MODULE64 structure: 144 bytes (0x90)
// Offset 0x00: Path RVA (4 bytes) - offset into strings table
// Offset 0x38: BaseAddress (8 bytes)
// Offset 0x48: Size (8 bytes)
const MODULE64_SIZE = 0x90;
const MODULE64_PATH_OFFSET = 0x00;
const MODULE64_BASE_OFFSET = 0x38;
const MODULE64_SIZE_OFFSET = 0x48;

export interface ParsedModule {
  name: string;
  base: bigint;
  size: bigint;
  end: bigint;
}

export interface BugCheckData {
  code: number;
  name: string;
  parameters: bigint[];
}

export interface ExceptionData {
  code: number;
  address: bigint;
  flags: number;
  module?: string;
}

export interface KernelDumpResult {
  format: string;
  architecture: string;
  bugCheck: BugCheckData;
  exception: ExceptionData;
  modules: ParsedModule[];
  culpritModule: string | null;
  fileSize: number;
}

/**
 * Parse UTF-16LE string from buffer at given offset
 */
function parseString(view: DataView, offset: number, maxLength: number = 256): string {
  if (offset + 4 > view.byteLength) return "";

  const length = view.getUint32(offset, true);
  if (length === 0 || length > maxLength) return "";

  const stringStart = offset + 4;
  if (stringStart + length * 2 > view.byteLength) return "";

  const chars: string[] = [];
  for (let i = 0; i < length; i++) {
    const charCode = view.getUint16(stringStart + i * 2, true);
    if (charCode === 0) break;
    chars.push(String.fromCharCode(charCode));
  }

  return chars.join('').replace(/\x00/g, '');
}

/**
 * Parse all strings from the strings table
 */
function parseStringsTable(view: DataView, stringsRva: number): Map<number, string> {
  const strings = new Map<number, string>();
  let offset = stringsRva;

  while (offset < view.byteLength - 4) {
    const length = view.getUint32(offset, true);
    if (length === 0 || length > 256) break;

    const str = parseString(view, offset);
    if (str) {
      strings.set(offset, str);
    }

    // Move to next string (8-byte aligned)
    let totalSize = 4 + length * 2 + 2; // length field + string + null terminator
    totalSize = (totalSize + 7) & ~7;   // 8-byte alignment
    offset += totalSize;
  }

  return strings;
}

/**
 * Extract filename from Windows path
 */
function extractFilename(path: string): string {
  const parts = path.split('\\');
  return parts[parts.length - 1] || path;
}

/**
 * Parse a PAGEDU64 (64-bit Windows kernel crash dump) file
 */
export function parseKernelDump64(buffer: ArrayBuffer): KernelDumpResult | null {
  if (buffer.byteLength < 0x2040) {
    console.error("Buffer too small for PAGEDU64 dump");
    return null;
  }

  const view = new DataView(buffer);

  // Check signature: 'PAGE' (0x45474150) + 'DU64' (0x34365544)
  const sig1 = view.getUint32(0x00, true);
  const sig2 = view.getUint32(0x04, true);

  if (sig1 !== 0x45474150 || sig2 !== 0x34365544) {
    console.error("Not a PAGEDU64 dump file");
    return null;
  }

  // Parse bug check info from header
  const bugCheckCode = view.getUint32(0x38, true);
  const bugCheckParams: bigint[] = [];
  for (let i = 0; i < 4; i++) {
    bugCheckParams.push(view.getBigUint64(0x40 + i * 8, true));
  }

  // Parse exception record at 0xF00
  const excCode = view.getUint32(0xF00, true);
  const excFlags = view.getUint32(0xF04, true);
  const excAddress = view.getBigUint64(0xF10, true);

  // Parse DUMP_0x2000 structure
  const dump2000Base = 0x2000;
  const stackRva = view.getUint32(dump2000Base + DUMP_0x2000_OFFSETS.StackRva, true);
  const modulesRva = view.getUint32(dump2000Base + DUMP_0x2000_OFFSETS.LoadedModules, true);
  const stringsRva = view.getUint32(dump2000Base + DUMP_0x2000_OFFSETS.StringsRva, true);

  // Parse strings table
  const strings = parseStringsTable(view, stringsRva);

  // Parse modules
  const modules: ParsedModule[] = [];
  let offset = modulesRva;

  while (offset + MODULE64_SIZE < view.byteLength) {
    const nameRva = view.getUint32(offset + MODULE64_PATH_OFFSET, true);

    // Check for end of module list
    if (nameRva === 0 || nameRva > view.byteLength) break;

    const baseAddr = view.getBigUint64(offset + MODULE64_BASE_OFFSET, true);
    const size = view.getBigUint64(offset + MODULE64_SIZE_OFFSET, true);

    const fullPath = strings.get(nameRva);
    if (fullPath && baseAddr > 0n && size > 0n) {
      modules.push({
        name: extractFilename(fullPath),
        base: baseAddr,
        size: size,
        end: baseAddr + size,
      });
    }

    offset += MODULE64_SIZE;
  }

  // Find culprit module (module containing exception address)
  let culpritModule: string | null = null;
  for (const module of modules) {
    if (excAddress >= module.base && excAddress < module.end) {
      culpritModule = module.name;
      break;
    }
  }

  return {
    format: "PAGEDU64",
    architecture: "x64",
    bugCheck: {
      code: bugCheckCode,
      name: BUG_CHECK_CODES[bugCheckCode] || "UNKNOWN",
      parameters: bugCheckParams,
    },
    exception: {
      code: excCode,
      address: excAddress,
      flags: excFlags,
      module: culpritModule || undefined,
    },
    modules,
    culpritModule,
    fileSize: buffer.byteLength,
  };
}

/**
 * Parse dump file and return structured result
 * Auto-detects PAGEDU64 vs other formats
 */
export function parseDumpFile(buffer: ArrayBuffer): KernelDumpResult | null {
  if (buffer.byteLength < 8) {
    console.error("Buffer too small");
    return null;
  }

  const view = new DataView(buffer);
  const sig1 = view.getUint32(0x00, true);
  const sig2 = view.getUint32(0x04, true);

  // Check for PAGEDU64 (64-bit kernel dump)
  if (sig1 === 0x45474150 && sig2 === 0x34365544) {
    return parseKernelDump64(buffer);
  }

  // Check for PAGEDUMP (32-bit kernel dump)
  if (sig1 === 0x45474150) {
    // 32-bit parsing would go here
    console.warn("32-bit kernel dumps not yet supported");
    return null;
  }

  console.error("Unknown dump format");
  return null;
}

/**
 * Format bigint as hex string
 */
export function formatHex(value: bigint, width: number = 16): string {
  return "0x" + value.toString(16).padStart(width, "0");
}

/**
 * Convert result to JSON-safe format (bigints as hex strings)
 */
export function toJsonSafe(result: KernelDumpResult): Record<string, unknown> {
  return {
    format: result.format,
    architecture: result.architecture,
    bugCheck: {
      code: "0x" + result.bugCheck.code.toString(16),
      name: result.bugCheck.name,
      parameters: result.bugCheck.parameters.map(p => formatHex(p)),
    },
    exception: {
      code: "0x" + result.exception.code.toString(16),
      address: formatHex(result.exception.address),
      flags: "0x" + result.exception.flags.toString(16),
      module: result.exception.module,
    },
    modules: result.modules.map(m => ({
      name: m.name,
      base: formatHex(m.base),
      size: formatHex(m.size),
      end: formatHex(m.end),
    })),
    culpritModule: result.culpritModule,
    fileSize: result.fileSize,
  };
}

// ============================================================================
// Legacy compatibility layer for kernelDumpParser.ts
// ============================================================================

import { parseContext, ParsedContext } from './contextParser.js';

// DUMP_HEADER64 structure offsets
const DUMP_HEADER64_OFFSETS = {
  Signature: 0x0,
  ValidDump: 0x4,
  MajorVersion: 0x8,
  MinorVersion: 0xC,
  DirectoryTableBase: 0x10,
  PfnDataBase: 0x18,
  PsLoadedModuleList: 0x20,
  PsActiveProcessHead: 0x28,
  MachineImageType: 0x30,
  NumberProcessors: 0x34,
  BugCheckCode: 0x38,
  BugCheckParameter1: 0x40,
  BugCheckParameter2: 0x48,
  BugCheckParameter3: 0x50,
  BugCheckParameter4: 0x58,
  KdDebuggerDataBlock: 0x80,
  PhysicalMemoryBlock: 0x88,
  ContextRecord: 0x348,
};

export interface PhysicalMemoryRun {
  basePage: bigint;
  pageCount: bigint;
}

export interface PhysicalMemoryDescriptor {
  numberOfRuns: number;
  numberOfPages: bigint;
  runs: PhysicalMemoryRun[];
}

export interface KernelDumpHeader {
  signature: string;
  majorVersion: number;
  minorVersion: number;
  directoryTableBase: bigint;
  pfnDatabase: bigint;
  psLoadedModuleList: bigint;
  psActiveProcessHead: bigint;
  machineImageType: number;
  numberOfProcessors: number;
  bugCheckCode: number;
  bugCheckParameters: bigint[];
  kdDebuggerDataBlock: bigint;
  physicalMemoryDescriptor?: PhysicalMemoryDescriptor;
  context?: ParsedContext;
  kernelBase?: bigint;
}

export interface KernelModule {
  dllBase: bigint;
  entryPoint: bigint;
  sizeOfImage: number;
  fullDllName: string;
  baseDllName: string;
  flags: number;
  loadCount: number;
  checkSum: number;
  timeDateStamp: number;
}

/**
 * Parse a DUMP_HEADER64 structure from a kernel dump
 * (Legacy compatibility function)
 */
export function parseKernelDumpHeader(buffer: ArrayBuffer): KernelDumpHeader | null {
  if (buffer.byteLength < 0x2000) {
    console.error('Buffer too small for kernel dump header');
    return null;
  }

  const view = new DataView(buffer);

  // Check signature: 'PAGE' = 0x45474150, 'DU64' = 0x34365544
  const sig1 = view.getUint32(DUMP_HEADER64_OFFSETS.Signature, true);
  const sig2 = view.getUint32(DUMP_HEADER64_OFFSETS.ValidDump, true);

  if (sig1 !== 0x45474150 || sig2 !== 0x34365544) {
    console.error('Invalid kernel dump signature');
    return null;
  }

  const header: KernelDumpHeader = {
    signature: 'PAGEDU64',
    majorVersion: view.getUint32(DUMP_HEADER64_OFFSETS.MajorVersion, true),
    minorVersion: view.getUint32(DUMP_HEADER64_OFFSETS.MinorVersion, true),
    directoryTableBase: view.getBigUint64(DUMP_HEADER64_OFFSETS.DirectoryTableBase, true),
    pfnDatabase: view.getBigUint64(DUMP_HEADER64_OFFSETS.PfnDataBase, true),
    psLoadedModuleList: view.getBigUint64(DUMP_HEADER64_OFFSETS.PsLoadedModuleList, true),
    psActiveProcessHead: view.getBigUint64(DUMP_HEADER64_OFFSETS.PsActiveProcessHead, true),
    machineImageType: view.getUint32(DUMP_HEADER64_OFFSETS.MachineImageType, true),
    numberOfProcessors: view.getUint32(DUMP_HEADER64_OFFSETS.NumberProcessors, true),
    bugCheckCode: view.getUint32(DUMP_HEADER64_OFFSETS.BugCheckCode, true),
    bugCheckParameters: [
      view.getBigUint64(DUMP_HEADER64_OFFSETS.BugCheckParameter1, true),
      view.getBigUint64(DUMP_HEADER64_OFFSETS.BugCheckParameter2, true),
      view.getBigUint64(DUMP_HEADER64_OFFSETS.BugCheckParameter3, true),
      view.getBigUint64(DUMP_HEADER64_OFFSETS.BugCheckParameter4, true),
    ],
    kdDebuggerDataBlock: view.getBigUint64(DUMP_HEADER64_OFFSETS.KdDebuggerDataBlock, true),
  };

  // Parse physical memory descriptor
  try {
    const physMemOffset = DUMP_HEADER64_OFFSETS.PhysicalMemoryBlock;
    const numberOfRuns = view.getUint32(physMemOffset, true);
    const numberOfPages = view.getBigUint64(physMemOffset + 8, true);

    const runs: PhysicalMemoryRun[] = [];
    let runOffset = physMemOffset + 16;

    for (let i = 0; i < numberOfRuns && runOffset + 16 <= buffer.byteLength; i++) {
      runs.push({
        basePage: view.getBigUint64(runOffset, true),
        pageCount: view.getBigUint64(runOffset + 8, true),
      });
      runOffset += 16;
    }

    header.physicalMemoryDescriptor = {
      numberOfRuns,
      numberOfPages,
      runs,
    };
  } catch (e) {
    console.error('Failed to parse physical memory descriptor:', e);
  }

  // Parse context record
  try {
    const is64Bit = header.machineImageType === 0x8664;
    const context = parseContext(buffer, DUMP_HEADER64_OFFSETS.ContextRecord, is64Bit);
    if (context) {
      header.context = context;
    }
  } catch (e) {
    console.error('Failed to parse context record:', e);
  }

  return header;
}

/**
 * Get processor architecture name from machine type
 */
export function getMachineTypeName(machineType: number): string {
  const machineTypes: Record<number, string> = {
    0x014c: 'x86',
    0x0200: 'IA64',
    0x8664: 'AMD64',
    0x01c0: 'ARM',
    0x01c4: 'ARMv7',
    0xAA64: 'ARM64',
  };
  return machineTypes[machineType] || `Unknown (0x${machineType.toString(16)})`;
}

/**
 * Validate kernel dump header
 */
export function validateKernelDumpHeader(header: KernelDumpHeader): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (header.majorVersion < 1 || header.majorVersion > 100) {
    errors.push(`Invalid major version: ${header.majorVersion}`);
  }

  const validMachineTypes = [0x014c, 0x0200, 0x8664, 0x01c0, 0x01c4, 0xAA64];
  if (!validMachineTypes.includes(header.machineImageType)) {
    errors.push(`Unknown machine type: 0x${header.machineImageType.toString(16)}`);
  }

  if (header.numberOfProcessors < 1 || header.numberOfProcessors > 1024) {
    errors.push(`Invalid processor count: ${header.numberOfProcessors}`);
  }

  if (header.directoryTableBase === 0n) {
    errors.push('Directory table base (CR3) is zero');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Format kernel dump header for display
 */
export function formatKernelDumpHeader(header: KernelDumpHeader): string {
  const lines: string[] = [];

  lines.push('=== Kernel Dump Header ===');
  lines.push(`Signature: ${header.signature}`);
  lines.push(`Version: ${header.majorVersion}.${header.minorVersion}`);
  lines.push(`Architecture: ${getMachineTypeName(header.machineImageType)}`);
  lines.push(`Processors: ${header.numberOfProcessors}`);
  lines.push('');

  if (header.bugCheckCode !== 0) {
    lines.push('Bug Check Information:');
    lines.push(`  Code: 0x${header.bugCheckCode.toString(16).padStart(8, '0')}`);
    lines.push(`  Parameter 1: 0x${header.bugCheckParameters[0].toString(16).padStart(16, '0')}`);
    lines.push(`  Parameter 2: 0x${header.bugCheckParameters[1].toString(16).padStart(16, '0')}`);
    lines.push(`  Parameter 3: 0x${header.bugCheckParameters[2].toString(16).padStart(16, '0')}`);
    lines.push(`  Parameter 4: 0x${header.bugCheckParameters[3].toString(16).padStart(16, '0')}`);
    lines.push('');
  }

  lines.push('System Information:');
  lines.push(`  Directory Table Base: 0x${header.directoryTableBase.toString(16).padStart(16, '0')}`);
  lines.push(`  PFN Database: 0x${header.pfnDatabase.toString(16).padStart(16, '0')}`);
  lines.push(`  Module List: 0x${header.psLoadedModuleList.toString(16).padStart(16, '0')}`);
  lines.push(`  Process List: 0x${header.psActiveProcessHead.toString(16).padStart(16, '0')}`);

  if (header.physicalMemoryDescriptor) {
    lines.push('');
    lines.push('Physical Memory:');
    lines.push(`  Total Pages: ${header.physicalMemoryDescriptor.numberOfPages}`);
    lines.push(`  Memory Runs: ${header.physicalMemoryDescriptor.numberOfRuns}`);
  }

  return lines.join('\n');
}

/**
 * Parse module list from kernel dump (stub - requires virtual address translation)
 */
export function parseKernelModuleList(
  _buffer: ArrayBuffer,
  _psLoadedModuleList: bigint,
  _directoryTableBase: bigint
): KernelModule[] {
  // Full implementation requires virtual to physical address translation
  return [];
}
