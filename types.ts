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

export interface AnalysisReportData {
  summary: string;
  probableCause: string;
  culprit: string;
  recommendations: string[];
  stackTrace: string[];
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