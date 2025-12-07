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
  // Legacy field - module list fallback when loadedModules is empty
  stackTrace?: string[];
  advancedAnalyses?: AdvancedAnalysisResult[];
}

export interface DumpFile {
  id: string;
  file: File;
  status: FileStatus;
  dumpType: 'minidump' | 'kernel';
  report?: AnalysisReportData;
  error?: string;
}