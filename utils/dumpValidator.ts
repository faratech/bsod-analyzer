/**
 * Comprehensive dump validation for improved accuracy
 */

interface BugCheckValidation {
  code: number;
  name: string;
  parameterDescriptions: string[];
  validate: (params: bigint[]) => { valid: boolean; errors: string[] };
}

// Common parameter validators
const validators = {
  isValidAddress: (addr: bigint): boolean => {
    // Kernel addresses typically start at 0xFFFF... on x64
    // User addresses are below 0x7FFFFFFFFFFF
    return addr > 0n && (addr < 0x7FFFFFFFFFFFn || addr >= 0xFFFF800000000000n);
  },
  
  isValidExceptionCode: (code: bigint): boolean => {
    const knownCodes = [
      0xC0000005n, // ACCESS_VIOLATION
      0xC00000FDn, // STACK_OVERFLOW
      0xC0000094n, // DIVIDE_BY_ZERO
      0xC0000096n, // PRIVILEGED_INSTRUCTION
      0x80000003n, // BREAKPOINT
      0x80000004n, // SINGLE_STEP
      0xC000001Dn, // ILLEGAL_INSTRUCTION
      0xC0000025n, // NONCONTINUABLE_EXCEPTION
      0xC00000E1n, // STATUS_VIRUS_INFECTED
      0xC0000420n, // STATUS_ASSERTION_FAILURE
    ];
    return knownCodes.includes(code);
  },
  
  isValidIrql: (irql: bigint): boolean => {
    return irql >= 0n && irql <= 31n;
  },
  
  isValidHandle: (handle: bigint): boolean => {
    // Handles are typically multiples of 4
    return handle > 0n && (handle & 3n) === 0n;
  },
  
  isValidNTStatus: (status: bigint): boolean => {
    // NT status codes have specific patterns
    const severity = (status >> 30n) & 3n;
    return severity >= 0n && severity <= 3n;
  }
};

// Bug check parameter validations
export const BUG_CHECK_VALIDATIONS: Map<number, BugCheckValidation> = new Map([
  [0x0A, {
    code: 0x0A,
    name: 'IRQL_NOT_LESS_OR_EQUAL',
    parameterDescriptions: [
      'Address that was referenced',
      'IRQL at time of reference',
      'Access type: 0=Read, 1=Write, 8=Execute',
      'Address of instruction that referenced'
    ],
    validate: (params) => {
      const errors: string[] = [];
      
      if (!validators.isValidAddress(params[0])) {
        errors.push(`Invalid memory address: 0x${params[0].toString(16)}`);
      }
      
      if (!validators.isValidIrql(params[1])) {
        errors.push(`Invalid IRQL value: ${params[1]}`);
      }
      
      const accessType = params[2];
      if (accessType !== 0n && accessType !== 1n && accessType !== 8n) {
        errors.push(`Invalid access type: ${accessType} (expected 0, 1, or 8)`);
      }
      
      if (!validators.isValidAddress(params[3])) {
        errors.push(`Invalid instruction address: 0x${params[3].toString(16)}`);
      }
      
      return { valid: errors.length === 0, errors };
    }
  }],
  
  [0x1E, {
    code: 0x1E,
    name: 'KMODE_EXCEPTION_NOT_HANDLED',
    parameterDescriptions: [
      'Exception code',
      'Address where exception occurred',
      'Exception parameter 0',
      'Exception parameter 1'
    ],
    validate: (params) => {
      const errors: string[] = [];
      
      if (!validators.isValidExceptionCode(params[0])) {
        errors.push(`Unknown exception code: 0x${params[0].toString(16)}`);
      }
      
      if (!validators.isValidAddress(params[1])) {
        errors.push(`Invalid exception address: 0x${params[1].toString(16)}`);
      }
      
      // Exception parameters depend on the exception code
      if (params[0] === 0xC0000005n) { // ACCESS_VIOLATION
        // Parameter 0: 0=Read, 1=Write, 8=Execute
        const accessType = params[2];
        if (accessType !== 0n && accessType !== 1n && accessType !== 8n) {
          errors.push(`Invalid access violation type: ${accessType}`);
        }
        // Parameter 1: Address being accessed
        if (!validators.isValidAddress(params[3])) {
          errors.push(`Invalid access violation address: 0x${params[3].toString(16)}`);
        }
      }
      
      return { valid: errors.length === 0, errors };
    }
  }],
  
  [0x50, {
    code: 0x50,
    name: 'PAGE_FAULT_IN_NONPAGED_AREA',
    parameterDescriptions: [
      'Address referenced',
      'Page protection (0=Read, 1=Write, 8=Execute, 10=ExecuteRead)',
      'Address of instruction (if known)',
      'Reserved'
    ],
    validate: (params) => {
      const errors: string[] = [];
      
      if (!validators.isValidAddress(params[0])) {
        errors.push(`Invalid referenced address: 0x${params[0].toString(16)}`);
      }
      
      const protection = params[1];
      const validProtections = [0n, 1n, 8n, 10n];
      if (!validProtections.includes(protection)) {
        errors.push(`Invalid page protection: ${protection}`);
      }
      
      // Parameter 2 can be 0 if address is unknown
      if (params[2] !== 0n && !validators.isValidAddress(params[2])) {
        errors.push(`Invalid instruction address: 0x${params[2].toString(16)}`);
      }
      
      return { valid: errors.length === 0, errors };
    }
  }],
  
  [0x7E, {
    code: 0x7E,
    name: 'SYSTEM_THREAD_EXCEPTION_NOT_HANDLED',
    parameterDescriptions: [
      'Exception code',
      'Address where exception occurred',
      'Exception record address',
      'Context record address'
    ],
    validate: (params) => {
      const errors: string[] = [];
      
      if (!validators.isValidExceptionCode(params[0])) {
        errors.push(`Invalid exception code: 0x${params[0].toString(16)}`);
      }
      
      if (!validators.isValidAddress(params[1])) {
        errors.push(`Invalid exception address: 0x${params[1].toString(16)}`);
      }
      
      if (!validators.isValidAddress(params[2])) {
        errors.push(`Invalid exception record address: 0x${params[2].toString(16)}`);
      }
      
      if (!validators.isValidAddress(params[3])) {
        errors.push(`Invalid context record address: 0x${params[3].toString(16)}`);
      }
      
      return { valid: errors.length === 0, errors };
    }
  }],
  
  [0xC2, {
    code: 0xC2,
    name: 'BAD_POOL_CALLER',
    parameterDescriptions: [
      'Pool type and allocation type',
      'Pool tag or address being freed',
      'Pool address or size',
      'Reserved'
    ],
    validate: (params) => {
      const errors: string[] = [];
      
      // Parameter 0 indicates the specific pool problem
      const poolProblem = params[0];
      const validProblems = [
        0x01n, 0x02n, 0x04n, 0x05n, 0x06n, 0x07n, 0x08n, 0x09n, 
        0x0An, 0x0Bn, 0x0Cn, 0x0Dn, 0x40n, 0x41n, 0x42n, 0x43n,
        0x44n, 0x45n, 0x46n, 0x47n, 0x48n, 0x49n, 0x99n
      ];
      
      if (!validProblems.includes(poolProblem)) {
        errors.push(`Unknown pool problem type: 0x${poolProblem.toString(16)}`);
      }
      
      // Validate based on specific problem type
      if (poolProblem === 0x01n || poolProblem === 0x02n) {
        // Pool header corruption - param 1 is pool tag
        if (params[1] === 0n) {
          errors.push('Pool tag should not be zero');
        }
      } else if (poolProblem >= 0x40n && poolProblem <= 0x49n) {
        // Free pool problems - param 1 should be valid address
        if (!validators.isValidAddress(params[1])) {
          errors.push(`Invalid pool address: 0x${params[1].toString(16)}`);
        }
      }
      
      return { valid: errors.length === 0, errors };
    }
  }],
  
  [0xD1, {
    code: 0xD1,
    name: 'DRIVER_IRQL_NOT_LESS_OR_EQUAL',
    parameterDescriptions: [
      'Address referenced',
      'IRQL at time of reference',
      'Access type: 0=Read, 1=Write, 8=Execute',
      'Address that referenced'
    ],
    validate: (params) => {
      const errors: string[] = [];
      
      if (!validators.isValidAddress(params[0])) {
        errors.push(`Invalid memory address: 0x${params[0].toString(16)}`);
      }
      
      // IRQL must be > DISPATCH_LEVEL (2) for this bug check
      if (params[1] <= 2n || !validators.isValidIrql(params[1])) {
        errors.push(`Invalid IRQL for DRIVER_IRQL_NOT_LESS_OR_EQUAL: ${params[1]}`);
      }
      
      const accessType = params[2];
      if (accessType !== 0n && accessType !== 1n && accessType !== 8n) {
        errors.push(`Invalid access type: ${accessType}`);
      }
      
      if (!validators.isValidAddress(params[3])) {
        errors.push(`Invalid instruction address: 0x${params[3].toString(16)}`);
      }
      
      return { valid: errors.length === 0, errors };
    }
  }],
  
  [0xF5, {
    code: 0xF5,
    name: 'FLTMGR_FILE_SYSTEM',
    parameterDescriptions: [
      'Filter manager error code',
      'FLT_OBJECT causing the error',
      'Reserved',
      'Reserved'
    ],
    validate: (params) => {
      const errors: string[] = [];
      
      // Known filter manager error codes
      const knownErrorCodes = [
        0x66n, // Invalid context registration
        0x67n, // Invalid context
        0x68n, // Invalid callback data
        0x6Bn, // Invalid name provider
        0x6Cn, // Duplicate handler
        0x6Dn, // Invalid filter
        0x6En, // Instance name collision
        0x6Fn, // Invalid altitude
        0x7An, // Name cache out of sync
      ];
      
      if (!knownErrorCodes.includes(params[0])) {
        errors.push(`Unknown filter manager error code: 0x${params[0].toString(16)}`);
      }
      
      // Parameter 1 should be a valid kernel address (FLT_OBJECT)
      if (params[1] !== 0n && !validators.isValidAddress(params[1])) {
        errors.push(`Invalid FLT_OBJECT address: 0x${params[1].toString(16)}`);
      }
      
      return { valid: errors.length === 0, errors };
    }
  }],
  
  [0x139, {
    code: 0x139,
    name: 'KERNEL_SECURITY_CHECK_FAILURE',
    parameterDescriptions: [
      'Security check type',
      'Address of failure',
      'Exception record (if applicable)',
      'Context record (if applicable)'
    ],
    validate: (params) => {
      const errors: string[] = [];
      
      // Known security check types
      const checkType = params[0];
      const knownTypes = [
        0x0n,  // Stack buffer overrun
        0x1n,  // Stack cookie check failure
        0x2n,  // Corrupt list entry
        0x3n,  // Kernel stack overflow
        0x4n,  // Invalid kernel stack address
        0x5n,  // Invalid IRQL
        0x6n,  // Critical structure corruption
        0x8n,  // Fast fail
        0xAn,  // Invalid buffer access
      ];
      
      if (!knownTypes.includes(checkType)) {
        errors.push(`Unknown security check type: 0x${checkType.toString(16)}`);
      }
      
      // Validate based on check type
      if (checkType === 0x0n || checkType === 0x1n) {
        // Stack-related checks should have valid stack address
        if (!validators.isValidAddress(params[1])) {
          errors.push(`Invalid stack address: 0x${params[1].toString(16)}`);
        }
      }
      
      // Exception and context records (if present)
      if (params[2] !== 0n && !validators.isValidAddress(params[2])) {
        errors.push(`Invalid exception record: 0x${params[2].toString(16)}`);
      }
      
      if (params[3] !== 0n && !validators.isValidAddress(params[3])) {
        errors.push(`Invalid context record: 0x${params[3].toString(16)}`);
      }
      
      return { valid: errors.length === 0, errors };
    }
  }],
]);

/**
 * Validates bug check parameters based on the specific bug check code
 */
export function validateBugCheckParameters(
  bugCheckCode: number, 
  params: bigint[]
): { valid: boolean; errors: string[]; description?: string } {
  const validation = BUG_CHECK_VALIDATIONS.get(bugCheckCode);
  
  if (!validation) {
    // For unknown bug checks, just validate that parameters are reasonable
    const errors: string[] = [];
    for (let i = 0; i < params.length; i++) {
      if (params[i] < 0n) {
        errors.push(`Parameter ${i + 1} is negative: ${params[i]}`);
      }
    }
    return { 
      valid: errors.length === 0, 
      errors,
      description: 'Unknown bug check code - basic validation only'
    };
  }
  
  const result = validation.validate(params);
  
  // Add parameter descriptions to the result
  const description = validation.parameterDescriptions
    .map((desc, i) => `P${i + 1}: ${desc}`)
    .join('\n');
  
  return { ...result, description };
}

/**
 * Cross-validates different data sources in the dump
 */
export class DumpValidator {
  /**
   * Validates that module addresses don't overlap
   */
  static validateModuleAddresses(modules: Array<{ name: string; base: bigint; size: number }>): string[] {
    const errors: string[] = [];
    
    // Sort modules by base address
    const sorted = [...modules].sort((a, b) => {
      if (a.base < b.base) return -1;
      if (a.base > b.base) return 1;
      return 0;
    });
    
    // Check for overlaps
    for (let i = 0; i < sorted.length - 1; i++) {
      const current = sorted[i];
      const next = sorted[i + 1];
      const currentEnd = current.base + BigInt(current.size);
      
      if (currentEnd > next.base) {
        errors.push(
          `Module overlap: ${current.name} (0x${current.base.toString(16)}-0x${currentEnd.toString(16)}) ` +
          `overlaps with ${next.name} (0x${next.base.toString(16)})`
        );
      }
    }
    
    // Validate address ranges
    for (const module of modules) {
      if (!validators.isValidAddress(module.base)) {
        errors.push(`Invalid module base address for ${module.name}: 0x${module.base.toString(16)}`);
      }
      
      if (module.size <= 0 || module.size > 0x10000000) { // 256MB max reasonable size
        errors.push(`Invalid module size for ${module.name}: ${module.size} bytes`);
      }
    }
    
    return errors;
  }
  
  /**
   * Validates stack frames
   */
  static validateStackFrames(frames: Array<{ address: bigint; functionName?: string }>): string[] {
    const errors: string[] = [];
    
    // Check for reasonable number of frames
    if (frames.length === 0) {
      errors.push('No stack frames found');
    } else if (frames.length > 1000) {
      errors.push(`Suspicious number of stack frames: ${frames.length}`);
    }
    
    // Validate each frame
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      
      if (!validators.isValidAddress(frame.address)) {
        errors.push(`Invalid address in stack frame ${i}: 0x${frame.address.toString(16)}`);
      }
      
      // Check for stack corruption patterns
      if (i > 0 && frame.address === frames[i - 1].address) {
        errors.push(`Duplicate address in stack frames ${i - 1} and ${i}`);
      }
    }
    
    // Check for common corruption patterns
    const uniqueAddresses = new Set(frames.map(f => f.address.toString()));
    if (uniqueAddresses.size < frames.length * 0.5) {
      errors.push('Possible stack corruption: too many duplicate addresses');
    }
    
    return errors;
  }
  
  /**
   * Validates thread information
   */
  static validateThreadInfo(thread: {
    id: number;
    teb: bigint;
    stackBase: bigint;
    stackLimit: bigint;
    priority: number;
    startAddress: bigint;
  }): string[] {
    const errors: string[] = [];
    
    // Validate TEB address
    if (!validators.isValidAddress(thread.teb)) {
      errors.push(`Invalid TEB address: 0x${thread.teb.toString(16)}`);
    }
    
    // Validate stack range
    if (!validators.isValidAddress(thread.stackBase)) {
      errors.push(`Invalid stack base: 0x${thread.stackBase.toString(16)}`);
    }
    
    if (!validators.isValidAddress(thread.stackLimit)) {
      errors.push(`Invalid stack limit: 0x${thread.stackLimit.toString(16)}`);
    }
    
    if (thread.stackBase <= thread.stackLimit) {
      errors.push('Stack base should be greater than stack limit');
    }
    
    const stackSize = thread.stackBase - thread.stackLimit;
    if (stackSize < 4096n || stackSize > 0x1000000n) { // 4KB to 16MB
      errors.push(`Unusual stack size: ${stackSize} bytes`);
    }
    
    // Validate priority
    if (thread.priority < 0 || thread.priority > 31) {
      errors.push(`Invalid thread priority: ${thread.priority}`);
    }
    
    // Validate start address
    if (!validators.isValidAddress(thread.startAddress)) {
      errors.push(`Invalid thread start address: 0x${thread.startAddress.toString(16)}`);
    }
    
    return errors;
  }
}

/**
 * Enhanced bug check analysis with parameter-specific insights
 */
export function analyzeBugCheckParameters(
  bugCheckCode: number,
  params: bigint[]
): { 
  analysis: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  likelyCauses: string[];
} {
  const bugCheckInfo = BUG_CHECK_VALIDATIONS.get(bugCheckCode);
  
  if (!bugCheckInfo) {
    return {
      analysis: 'Unknown bug check code',
      severity: 'medium',
      likelyCauses: ['Unknown system error']
    };
  }
  
  let analysis = `${bugCheckInfo.name}:\n`;
  let likelyCauses: string[] = [];
  let severity: 'critical' | 'high' | 'medium' | 'low' = 'high';
  
  switch (bugCheckCode) {
    case 0x0A: // IRQL_NOT_LESS_OR_EQUAL
      analysis += `Memory access at 0x${params[0].toString(16)} from IRQL ${params[1]}\n`;
      analysis += `Access type: ${params[2] === 0n ? 'Read' : params[2] === 1n ? 'Write' : 'Execute'}\n`;
      analysis += `Faulting instruction: 0x${params[3].toString(16)}`;
      
      if (params[1] >= 2n) {
        likelyCauses.push('Driver attempting paged pool access at DISPATCH_LEVEL or above');
        severity = 'critical';
      }
      if (params[0] < 0x10000n) {
        likelyCauses.push('NULL pointer dereference');
        likelyCauses.push('Uninitialized pointer usage');
      }
      break;
      
    case 0x1E: // KMODE_EXCEPTION_NOT_HANDLED
      const exceptionCode = params[0];
      analysis += `Exception code: 0x${exceptionCode.toString(16)}\n`;
      analysis += `Exception at: 0x${params[1].toString(16)}`;
      
      if (exceptionCode === 0xC0000005n) {
        analysis += '\nAccess Violation:\n';
        analysis += `  Type: ${params[2] === 0n ? 'Read' : params[2] === 1n ? 'Write' : 'Execute'}\n`;
        analysis += `  Address: 0x${params[3].toString(16)}`;
        likelyCauses.push('Invalid memory access');
        likelyCauses.push('Use after free');
        likelyCauses.push('Buffer overflow');
      } else if (exceptionCode === 0xC00000FDn) {
        likelyCauses.push('Stack overflow');
        likelyCauses.push('Infinite recursion');
        severity = 'critical';
      }
      break;
      
    case 0x50: // PAGE_FAULT_IN_NONPAGED_AREA
      analysis += `Failed to access: 0x${params[0].toString(16)}\n`;
      analysis += `Operation: ${params[1] === 0n ? 'Read' : params[1] === 1n ? 'Write' : 'Execute'}`;
      
      if (params[0] >= 0xFFFF800000000000n) {
        likelyCauses.push('System memory corruption');
        likelyCauses.push('Invalid system space reference');
        severity = 'critical';
      } else {
        likelyCauses.push('Paged out memory accessed at high IRQL');
        likelyCauses.push('MDL corruption');
      }
      break;
      
    case 0xF5: // FLTMGR_FILE_SYSTEM
      const errorCode = params[0];
      analysis += `Filter Manager error: 0x${errorCode.toString(16)}\n`;
      
      if (errorCode === 0x66n) {
        likelyCauses.push('Invalid context registration in minifilter');
      } else if (errorCode === 0x6Fn) {
        likelyCauses.push('Minifilter altitude conflict');
      } else if (errorCode === 0x7An) {
        likelyCauses.push('File system filter name cache corruption');
        severity = 'critical';
      }
      break;
  }
  
  return { analysis, severity, likelyCauses };
}