import { DumpFile, FileAnalysisResult, FileStatus } from '../types';

// The file's state once analyzeDumpFiles reports its outcome. A WinDBG result
// kept after an AI-only failure stays only while the file is in ERROR (Retry
// then runs just the AI step, issue #331); any other outcome drops it, and it
// goes away with the file when the file is removed.
export function applyFileResult(df: DumpFile, result: FileAnalysisResult): DumpFile {
    if (result.report) {
        return {
            ...df,
            status: FileStatus.ANALYZED,
            report: result.report,
            cached: result.cached || false,
            analysisMethod: result.analysisMethod,
            windbgResult: undefined
        };
    }
    return {
        ...df,
        status: FileStatus.ERROR,
        error: result.error || 'Unknown analysis error',
        windbgResult: result.windbgResult
    };
}
