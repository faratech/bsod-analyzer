import { useState, useCallback } from 'react';
import { DumpFile, FileStatus } from '../types';
import { analyzeDumpFiles } from '../services/geminiProxy';

export const useAnalysis = () => {
    const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
    const [error, setError] = useState<string | null>(null);

    const analyzeFiles = useCallback(async (
        dumpFiles: DumpFile[],
        onUpdate: (updater: (prevFiles: DumpFile[]) => DumpFile[]) => void,
        analytics?: {
            trackAnalysisStart?: (dumpType: string) => void;
            trackAnalysisComplete?: (success: boolean, dumpType: string) => void;
        }
    ) => {
        setIsAnalyzing(true);
        setError(null);

        const filesToAnalyze = dumpFiles.filter(df => df.status === FileStatus.PENDING);
        
        if (filesToAnalyze.length === 0) {
            setIsAnalyzing(false);
            return;
        }

        // Mark files as analyzing
        onUpdate(prevFiles =>
            prevFiles.map(df => 
                filesToAnalyze.some(fta => fta.id === df.id) 
                    ? { ...df, status: FileStatus.ANALYZING } 
                    : df
            )
        );

        try {
            // Track analysis start for each file
            if (analytics?.trackAnalysisStart) {
                filesToAnalyze.forEach(file => {
                    analytics.trackAnalysisStart(file.dumpType);
                });
            }

            const analysisResults = await analyzeDumpFiles(filesToAnalyze);

            // Update files with results
            onUpdate(prevFiles =>
                prevFiles.map(df => {
                    const result = analysisResults.find(r => r.id === df.id);
                    if (result) {
                        if (result.report) {
                            // Track successful analysis
                            if (analytics?.trackAnalysisComplete) {
                                analytics.trackAnalysisComplete(true, df.dumpType);
                            }
                            return { ...df, status: FileStatus.ANALYZED, report: result.report };
                        }
                        // Track failed analysis
                        if (analytics?.trackAnalysisComplete) {
                            analytics.trackAnalysisComplete(false, df.dumpType);
                        }
                        return { ...df, status: FileStatus.ERROR, error: result.error || 'Unknown analysis error' };
                    }
                    return df;
                })
            );
        } catch (e) {
            console.error("Analysis failed:", e);
            setError('A critical error occurred during analysis.');
            onUpdate(prevFiles =>
                prevFiles.map(df =>
                    df.status === FileStatus.ANALYZING ? { ...df, status: FileStatus.ERROR, error: 'Analysis failed' } : df
                )
            );
        } finally {
            setIsAnalyzing(false);
        }
    }, []);

    const updateAdvancedAnalysis = useCallback((
        fileId: string,
        tool: string,
        result: string,
        dumpFiles: DumpFile[],
        onUpdate: (updater: (prevFiles: DumpFile[]) => DumpFile[]) => void
    ) => {
        onUpdate(prevFiles =>
            prevFiles.map(df => {
                if (df.id === fileId && df.report) {
                    const newAdvancedAnalyses = [
                        ...(df.report.advancedAnalyses || []),
                        { tool, result }
                    ];
                    return {
                        ...df,
                        report: {
                            ...df.report,
                            advancedAnalyses: newAdvancedAnalyses
                        }
                    };
                }
                return df;
            })
        );
    }, []);

    return {
        isAnalyzing,
        error,
        setError,
        analyzeFiles,
        updateAdvancedAnalysis
    };
};