export enum FileStatus {
  PENDING = 'PENDING',
  ANALYZING = 'ANALYZING',
  ANALYZED = 'ANALYZED',
  ERROR = 'ERROR',
}

export interface AdvancedAnalysisResult {
  tool: string;
  result: string;
}

export interface BugCheckInfo {
  code: string;           // e.g., "0x0000001A"
  name: string;           // e.g., "MEMORY_MANAGEMENT"
  parameters: {
    value: string;
    meaning: string;
  }[];
}

export interface CrashLocation {
  module: string;         // e.g., "ntoskrnl.exe"
  address: string;        // e.g., "0xfffff80002cb1ea0"
  offset?: string;        // e.g., "+0x93ea0"
}

export interface RegisterContext {
  rip?: string;
  rsp?: string;
  rbp?: string;
  rax?: string;
  rbx?: string;
  rcx?: string;
  rdx?: string;
  // x86 equivalents
  eip?: string;
  esp?: string;
  ebp?: string;
}

export interface LoadedModule {
  name: string;
  base?: string;
  size?: string;
  timestamp?: string;
  version?: string;
  isCulprit?: boolean;
}

export interface StackFrame {
  address: string;
  module: string;
  function?: string;
  offset?: string;
}

export interface SystemInfo {
  windowsVersion?: string;    // e.g., "10.0.22631.4460"
  systemUptime?: string;      // e.g., "0 days 4:23:45"
  processName?: string;       // e.g., "System", "chrome.exe"
}

export interface DriverWarning {
  driverName: string;
  displayName: string;
  manufacturer: string;
  category: string;
  issues: string[];
  recommendations: string[];
  isAssociatedWithBugCheck: boolean;
}

export interface HardwareErrorInfo {
  isHardwareError: boolean;
  errorType: string;
  component: string;
  severity: string;  // AI returns: 'fatal', 'recoverable', 'corrected', 'deferred'
  details: string[];
  recommendations: string[];
}

export interface ParameterAnalysis {
  parameter: string;   // e.g., "Parameter 1"
  rawValue: string;    // e.g., "0xC0000005"
  decoded: string;     // e.g., "STATUS_ACCESS_VIOLATION - Invalid memory access"
  significance: string; // What this tells us about the crash
}

export interface AnalysisReportData {
  summary: string;
  probableCause: string;
  culprit: string;
  recommendations: string[];
  // Enhanced data
  bugCheck?: BugCheckInfo;
  crashLocation?: CrashLocation;
  registers?: RegisterContext;
  loadedModules?: LoadedModule[];
  driverWarnings?: DriverWarning[];
  hardwareError?: HardwareErrorInfo;
  parameterAnalysis?: ParameterAnalysis[];  // AI-decoded bug check parameters
  // Legacy field - module list fallback when loadedModules is empty
  stackTrace?: string[];
  advancedAnalyses?: AdvancedAnalysisResult[];
  // Legacy field for bug check code (deprecated, use bugCheck instead)
  bugCheckCode?: string;
  // WinDBG-specific fields (parsed directly from raw output)
  failureBucketId?: string;   // Searchable crash signature
  symbolName?: string;        // e.g., "nt!MmAccessFault+0x93ea0"
  faultAddress?: string;      // Memory address that faulted
  systemInfo?: SystemInfo;
  callStack?: StackFrame[];   // Actual call stack (not just loaded modules)
  rawWinDbgOutput?: string;   // Full !analyze -v output for advanced users
}

export interface DumpFile {
  id: string;
  file: File;
  status: FileStatus;
  dumpType: 'minidump' | 'kernel';
  report?: AnalysisReportData;
  error?: string;
  cached?: boolean; // True if the analysis result was served from cache
  fileHash?: string; // Pre-computed xxhash64 of file content
  knownCached?: boolean; // True if cache check detected this file before analysis
}