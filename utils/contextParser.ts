/**
 * CONTEXT record parser for accurate thread state extraction
 */

// x64 CONTEXT structure offsets and flags
export const CONTEXT_AMD64 = {
  // Context flags
  CONTEXT_AMD64_CONTROL: 0x00100001,
  CONTEXT_AMD64_INTEGER: 0x00100002,
  CONTEXT_AMD64_SEGMENTS: 0x00100004,
  CONTEXT_AMD64_FLOATING_POINT: 0x00100008,
  CONTEXT_AMD64_DEBUG_REGISTERS: 0x00100010,
  CONTEXT_AMD64_FULL: 0x00100007,
  CONTEXT_AMD64_ALL: 0x0010001F,
  
  // Structure size
  SIZE: 0x4D0, // 1232 bytes
  
  // Offsets in the structure
  OFFSETS: {
    // Home addresses for first 4 parameters
    P1Home: 0x0,
    P2Home: 0x8,
    P3Home: 0x10,
    P4Home: 0x18,
    P5Home: 0x20,
    P6Home: 0x28,
    
    // Control flags
    ContextFlags: 0x30,
    MxCsr: 0x34,
    
    // Segment registers
    SegCs: 0x38,
    SegDs: 0x3A,
    SegEs: 0x3C,
    SegFs: 0x3E,
    SegGs: 0x40,
    SegSs: 0x42,
    
    // Debug control
    EFlags: 0x44,
    
    // Debug registers
    Dr0: 0x48,
    Dr1: 0x50,
    Dr2: 0x58,
    Dr3: 0x60,
    Dr6: 0x68,
    Dr7: 0x70,
    
    // Integer registers
    Rax: 0x78,
    Rcx: 0x80,
    Rdx: 0x88,
    Rbx: 0x90,
    Rsp: 0x98,
    Rbp: 0xA0,
    Rsi: 0xA8,
    Rdi: 0xB0,
    R8: 0xB8,
    R9: 0xC0,
    R10: 0xC8,
    R11: 0xD0,
    R12: 0xD8,
    R13: 0xE0,
    R14: 0xE8,
    R15: 0xF0,
    
    // Program counter
    Rip: 0xF8,
    
    // Floating point state (x87 FPU/MMX)
    FltSave: 0x100,
    Legacy: 0x120,
    Xmm0: 0x1A0,
    Xmm1: 0x1B0,
    Xmm2: 0x1C0,
    Xmm3: 0x1D0,
    Xmm4: 0x1E0,
    Xmm5: 0x1F0,
    Xmm6: 0x200,
    Xmm7: 0x210,
    Xmm8: 0x220,
    Xmm9: 0x230,
    Xmm10: 0x240,
    Xmm11: 0x250,
    Xmm12: 0x260,
    Xmm13: 0x270,
    Xmm14: 0x280,
    Xmm15: 0x290,
    
    // Vector registers
    VectorRegister: 0x300,
    VectorControl: 0x4A0,
    
    // Special debug control
    DebugControl: 0x4A8,
    LastBranchToRip: 0x4B0,
    LastBranchFromRip: 0x4B8,
    LastExceptionToRip: 0x4C0,
    LastExceptionFromRip: 0x4C8,
  }
};

// x86 CONTEXT structure for 32-bit dumps
export const CONTEXT_X86 = {
  CONTEXT_i386_CONTROL: 0x00010001,
  CONTEXT_i386_INTEGER: 0x00010002,
  CONTEXT_i386_SEGMENTS: 0x00010004,
  CONTEXT_i386_FLOATING_POINT: 0x00010008,
  CONTEXT_i386_DEBUG_REGISTERS: 0x00010010,
  CONTEXT_i386_FULL: 0x00010007,
  
  SIZE: 0x2CC, // 716 bytes
  
  OFFSETS: {
    ContextFlags: 0x0,
    Dr0: 0x4,
    Dr1: 0x8,
    Dr2: 0xC,
    Dr3: 0x10,
    Dr6: 0x14,
    Dr7: 0x18,
    FloatSave: 0x1C,
    SegGs: 0x8C,
    SegFs: 0x90,
    SegEs: 0x94,
    SegDs: 0x98,
    Edi: 0x9C,
    Esi: 0xA0,
    Ebx: 0xA4,
    Edx: 0xA8,
    Ecx: 0xAC,
    Eax: 0xB0,
    Ebp: 0xB4,
    Eip: 0xB8,
    SegCs: 0xBC,
    EFlags: 0xC0,
    Esp: 0xC4,
    SegSs: 0xC8,
  }
};

export interface ParsedContext {
  // Control
  contextFlags: number;
  
  // Segments
  cs: number;
  ds: number;
  es: number;
  fs: number;
  gs: number;
  ss: number;
  
  // Flags
  eflags: number;
  
  // Debug registers
  dr0: bigint;
  dr1: bigint;
  dr2: bigint;
  dr3: bigint;
  dr6: bigint;
  dr7: bigint;
  
  // Integer registers (x64)
  rax?: bigint;
  rbx?: bigint;
  rcx?: bigint;
  rdx?: bigint;
  rsp?: bigint;
  rbp?: bigint;
  rsi?: bigint;
  rdi?: bigint;
  r8?: bigint;
  r9?: bigint;
  r10?: bigint;
  r11?: bigint;
  r12?: bigint;
  r13?: bigint;
  r14?: bigint;
  r15?: bigint;
  rip?: bigint;
  
  // Integer registers (x86)
  eax?: number;
  ebx?: number;
  ecx?: number;
  edx?: number;
  esp?: number;
  ebp?: number;
  esi?: number;
  edi?: number;
  eip?: number;
  
  // Floating point state
  mxCsr?: number;
  
  // Analysis helpers
  is64Bit: boolean;
  instructionPointer: bigint;
  stackPointer: bigint;
  framePointer: bigint;
  
  // Exception information if available
  exceptionCode?: number;
  exceptionFlags?: number;
  exceptionAddress?: bigint;
}

/**
 * Parse a CONTEXT record from raw bytes
 */
export function parseContext(buffer: ArrayBuffer, offset: number, is64Bit: boolean = true): ParsedContext | null {
  try {
    const view = new DataView(buffer);
    
    if (is64Bit) {
      return parseAmd64Context(view, offset);
    } else {
      return parseX86Context(view, offset);
    }
  } catch (error) {
    console.error('Failed to parse CONTEXT:', error);
    return null;
  }
}

/**
 * Parse AMD64 (x64) CONTEXT structure
 */
function parseAmd64Context(view: DataView, offset: number): ParsedContext {
  const ctx = CONTEXT_AMD64.OFFSETS;
  
  // Read all registers
  const context: ParsedContext = {
    // Control flags
    contextFlags: view.getUint32(offset + ctx.ContextFlags, true),
    
    // Segments
    cs: view.getUint16(offset + ctx.SegCs, true),
    ds: view.getUint16(offset + ctx.SegDs, true),
    es: view.getUint16(offset + ctx.SegEs, true),
    fs: view.getUint16(offset + ctx.SegFs, true),
    gs: view.getUint16(offset + ctx.SegGs, true),
    ss: view.getUint16(offset + ctx.SegSs, true),
    
    // Flags
    eflags: view.getUint32(offset + ctx.EFlags, true),
    
    // Debug registers
    dr0: view.getBigUint64(offset + ctx.Dr0, true),
    dr1: view.getBigUint64(offset + ctx.Dr1, true),
    dr2: view.getBigUint64(offset + ctx.Dr2, true),
    dr3: view.getBigUint64(offset + ctx.Dr3, true),
    dr6: view.getBigUint64(offset + ctx.Dr6, true),
    dr7: view.getBigUint64(offset + ctx.Dr7, true),
    
    // Integer registers
    rax: view.getBigUint64(offset + ctx.Rax, true),
    rbx: view.getBigUint64(offset + ctx.Rbx, true),
    rcx: view.getBigUint64(offset + ctx.Rcx, true),
    rdx: view.getBigUint64(offset + ctx.Rdx, true),
    rsp: view.getBigUint64(offset + ctx.Rsp, true),
    rbp: view.getBigUint64(offset + ctx.Rbp, true),
    rsi: view.getBigUint64(offset + ctx.Rsi, true),
    rdi: view.getBigUint64(offset + ctx.Rdi, true),
    r8: view.getBigUint64(offset + ctx.R8, true),
    r9: view.getBigUint64(offset + ctx.R9, true),
    r10: view.getBigUint64(offset + ctx.R10, true),
    r11: view.getBigUint64(offset + ctx.R11, true),
    r12: view.getBigUint64(offset + ctx.R12, true),
    r13: view.getBigUint64(offset + ctx.R13, true),
    r14: view.getBigUint64(offset + ctx.R14, true),
    r15: view.getBigUint64(offset + ctx.R15, true),
    rip: view.getBigUint64(offset + ctx.Rip, true),
    
    // Floating point
    mxCsr: view.getUint32(offset + ctx.MxCsr, true),
    
    // Analysis helpers
    is64Bit: true,
    instructionPointer: view.getBigUint64(offset + ctx.Rip, true),
    stackPointer: view.getBigUint64(offset + ctx.Rsp, true),
    framePointer: view.getBigUint64(offset + ctx.Rbp, true),
  };
  
  return context;
}

/**
 * Parse x86 (32-bit) CONTEXT structure
 */
function parseX86Context(view: DataView, offset: number): ParsedContext {
  const ctx = CONTEXT_X86.OFFSETS;
  
  const context: ParsedContext = {
    // Control flags
    contextFlags: view.getUint32(offset + ctx.ContextFlags, true),
    
    // Segments
    cs: view.getUint32(offset + ctx.SegCs, true),
    ds: view.getUint32(offset + ctx.SegDs, true),
    es: view.getUint32(offset + ctx.SegEs, true),
    fs: view.getUint32(offset + ctx.SegFs, true),
    gs: view.getUint32(offset + ctx.SegGs, true),
    ss: view.getUint32(offset + ctx.SegSs, true),
    
    // Flags
    eflags: view.getUint32(offset + ctx.EFlags, true),
    
    // Debug registers (32-bit)
    dr0: BigInt(view.getUint32(offset + ctx.Dr0, true)),
    dr1: BigInt(view.getUint32(offset + ctx.Dr1, true)),
    dr2: BigInt(view.getUint32(offset + ctx.Dr2, true)),
    dr3: BigInt(view.getUint32(offset + ctx.Dr3, true)),
    dr6: BigInt(view.getUint32(offset + ctx.Dr6, true)),
    dr7: BigInt(view.getUint32(offset + ctx.Dr7, true)),
    
    // Integer registers
    eax: view.getUint32(offset + ctx.Eax, true),
    ebx: view.getUint32(offset + ctx.Ebx, true),
    ecx: view.getUint32(offset + ctx.Ecx, true),
    edx: view.getUint32(offset + ctx.Edx, true),
    esp: view.getUint32(offset + ctx.Esp, true),
    ebp: view.getUint32(offset + ctx.Ebp, true),
    esi: view.getUint32(offset + ctx.Esi, true),
    edi: view.getUint32(offset + ctx.Edi, true),
    eip: view.getUint32(offset + ctx.Eip, true),
    
    // Analysis helpers
    is64Bit: false,
    instructionPointer: BigInt(view.getUint32(offset + ctx.Eip, true)),
    stackPointer: BigInt(view.getUint32(offset + ctx.Esp, true)),
    framePointer: BigInt(view.getUint32(offset + ctx.Ebp, true)),
  };
  
  return context;
}

/**
 * Analyze EFLAGS register for state information
 */
export function analyzeEflags(eflags: number): {
  carry: boolean;
  parity: boolean;
  adjust: boolean;
  zero: boolean;
  sign: boolean;
  trap: boolean;
  interrupt: boolean;
  direction: boolean;
  overflow: boolean;
  iopl: number;
  nested: boolean;
  resume: boolean;
  virtual8086: boolean;
  alignment: boolean;
  virtualInterrupt: boolean;
  virtualInterruptPending: boolean;
  cpuid: boolean;
} {
  return {
    carry: (eflags & 0x1) !== 0,                    // CF
    parity: (eflags & 0x4) !== 0,                   // PF
    adjust: (eflags & 0x10) !== 0,                  // AF
    zero: (eflags & 0x40) !== 0,                    // ZF
    sign: (eflags & 0x80) !== 0,                    // SF
    trap: (eflags & 0x100) !== 0,                   // TF
    interrupt: (eflags & 0x200) !== 0,              // IF
    direction: (eflags & 0x400) !== 0,              // DF
    overflow: (eflags & 0x800) !== 0,               // OF
    iopl: (eflags >> 12) & 0x3,                     // IOPL
    nested: (eflags & 0x4000) !== 0,                // NT
    resume: (eflags & 0x10000) !== 0,               // RF
    virtual8086: (eflags & 0x20000) !== 0,          // VM
    alignment: (eflags & 0x40000) !== 0,            // AC
    virtualInterrupt: (eflags & 0x80000) !== 0,     // VIF
    virtualInterruptPending: (eflags & 0x100000) !== 0, // VIP
    cpuid: (eflags & 0x200000) !== 0,               // ID
  };
}

/**
 * Format context for display
 */
export function formatContext(context: ParsedContext): string {
  const lines: string[] = [];
  
  if (context.is64Bit) {
    lines.push('=== AMD64 Context ===');
    lines.push(`RIP: 0x${context.rip?.toString(16).padStart(16, '0')}`);
    lines.push(`RSP: 0x${context.rsp?.toString(16).padStart(16, '0')}`);
    lines.push(`RBP: 0x${context.rbp?.toString(16).padStart(16, '0')}`);
    lines.push('');
    lines.push('General Purpose Registers:');
    lines.push(`RAX: 0x${context.rax?.toString(16).padStart(16, '0')}  R8:  0x${context.r8?.toString(16).padStart(16, '0')}`);
    lines.push(`RBX: 0x${context.rbx?.toString(16).padStart(16, '0')}  R9:  0x${context.r9?.toString(16).padStart(16, '0')}`);
    lines.push(`RCX: 0x${context.rcx?.toString(16).padStart(16, '0')}  R10: 0x${context.r10?.toString(16).padStart(16, '0')}`);
    lines.push(`RDX: 0x${context.rdx?.toString(16).padStart(16, '0')}  R11: 0x${context.r11?.toString(16).padStart(16, '0')}`);
    lines.push(`RSI: 0x${context.rsi?.toString(16).padStart(16, '0')}  R12: 0x${context.r12?.toString(16).padStart(16, '0')}`);
    lines.push(`RDI: 0x${context.rdi?.toString(16).padStart(16, '0')}  R13: 0x${context.r13?.toString(16).padStart(16, '0')}`);
    lines.push(`                                  R14: 0x${context.r14?.toString(16).padStart(16, '0')}`);
    lines.push(`                                  R15: 0x${context.r15?.toString(16).padStart(16, '0')}`);
  } else {
    lines.push('=== x86 Context ===');
    lines.push(`EIP: 0x${context.eip?.toString(16).padStart(8, '0')}`);
    lines.push(`ESP: 0x${context.esp?.toString(16).padStart(8, '0')}`);
    lines.push(`EBP: 0x${context.ebp?.toString(16).padStart(8, '0')}`);
    lines.push('');
    lines.push('General Purpose Registers:');
    lines.push(`EAX: 0x${context.eax?.toString(16).padStart(8, '0')}  ESI: 0x${context.esi?.toString(16).padStart(8, '0')}`);
    lines.push(`EBX: 0x${context.ebx?.toString(16).padStart(8, '0')}  EDI: 0x${context.edi?.toString(16).padStart(8, '0')}`);
    lines.push(`ECX: 0x${context.ecx?.toString(16).padStart(8, '0')}`);
    lines.push(`EDX: 0x${context.edx?.toString(16).padStart(8, '0')}`);
  }
  
  lines.push('');
  lines.push('Segment Registers:');
  lines.push(`CS: 0x${context.cs.toString(16).padStart(4, '0')}  SS: 0x${context.ss.toString(16).padStart(4, '0')}`);
  lines.push(`DS: 0x${context.ds.toString(16).padStart(4, '0')}  ES: 0x${context.es.toString(16).padStart(4, '0')}`);
  lines.push(`FS: 0x${context.fs.toString(16).padStart(4, '0')}  GS: 0x${context.gs.toString(16).padStart(4, '0')}`);
  
  lines.push('');
  lines.push(`EFLAGS: 0x${context.eflags.toString(16).padStart(8, '0')}`);
  
  const flags = analyzeEflags(context.eflags);
  const flagStr = [
    flags.carry ? 'CF' : '',
    flags.parity ? 'PF' : '',
    flags.zero ? 'ZF' : '',
    flags.sign ? 'SF' : '',
    flags.trap ? 'TF' : '',
    flags.interrupt ? 'IF' : '',
    flags.direction ? 'DF' : '',
    flags.overflow ? 'OF' : '',
  ].filter(f => f).join(' ');
  
  if (flagStr) {
    lines.push(`Flags: ${flagStr}`);
  }
  
  return lines.join('\n');
}

/**
 * Detect anomalies in context that might indicate corruption
 */
export function detectContextAnomalies(context: ParsedContext): string[] {
  const anomalies: string[] = [];
  
  // Check for null instruction pointer
  if (context.instructionPointer === 0n) {
    anomalies.push('Instruction pointer is NULL');
  }
  
  // Check for null stack pointer
  if (context.stackPointer === 0n) {
    anomalies.push('Stack pointer is NULL');
  }
  
  // Check for misaligned stack
  if (context.is64Bit && (context.stackPointer & 0xFn) !== 0n) {
    anomalies.push('Stack pointer is not 16-byte aligned');
  } else if (!context.is64Bit && (context.stackPointer & 0x3n) !== 0n) {
    anomalies.push('Stack pointer is not 4-byte aligned');
  }
  
  // Check for kernel/user mode mismatch
  if (context.cs === 0x33) { // User mode CS on x64
    if (context.is64Bit && context.rip && context.rip >= 0xFFFF800000000000n) {
      anomalies.push('User mode CS but kernel address in RIP');
    }
  } else if (context.cs === 0x10) { // Kernel mode CS on x64
    if (context.is64Bit && context.rip && context.rip < 0xFFFF800000000000n) {
      anomalies.push('Kernel mode CS but user address in RIP');
    }
  }
  
  // Check for stack overflow
  if (context.stackPointer < context.framePointer - 0x100000n) {
    anomalies.push('Possible stack overflow detected');
  }
  
  // Check debug registers
  if (context.dr0 !== 0n || context.dr1 !== 0n || context.dr2 !== 0n || context.dr3 !== 0n) {
    anomalies.push('Hardware breakpoints are set');
  }
  
  // Check for single-step mode
  const flags = analyzeEflags(context.eflags);
  if (flags.trap) {
    anomalies.push('Single-step flag (TF) is set');
  }
  
  return anomalies;
}