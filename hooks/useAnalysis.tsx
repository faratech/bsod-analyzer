import { useState, useCallback } from 'react';
import { DumpFile, FileStatus } from '../types';
import { analyzeDumpFiles } from '../services/geminiProxy';
import { useError } from './useError';

export type AnalysisStage = 'uploading' | 'queued' | 'processing' | 'downloading' | 'analyzing' | 'complete';

export interface AnalysisProgress {
    stage: AnalysisStage;
    message: string;
    startTime: number;
}

export const useAnalysis = () => {
    const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
    const [progress, setProgress] = useState<AnalysisProgress | null>(null);
    const { error, setError, clearError } = useError();

    const analyzeFiles = useCallback(async (
        dumpFiles: DumpFile[],
        onUpdate: (updater: (prevFiles: DumpFile[]) => DumpFile[]) => void,
        analytics?: {
            trackAnalysisStart?: (dumpType: string) => void;
            trackAnalysisComplete?: (success: boolean, dumpType: string) => void;
        }
    ) => {
        setIsAnalyzing(true);
        clearError();

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

        // Initialize progress tracking
        const startTime = Date.now();
        setProgress({
            stage: 'uploading',
            message: 'Preparing analysis...',
            startTime
        });

        try {
            // Track analysis start for each file
            if (analytics?.trackAnalysisStart) {
                filesToAnalyze.forEach(file => {
                    analytics.trackAnalysisStart(file.dumpType);
                });
            }

            // Progress callback for WinDBG stages
            const onProgress = (stage: AnalysisStage, message: string) => {
                setProgress({
                    stage,
                    message,
                    startTime
                });
            };

            // Callback to update UI immediately when each file completes
            const onFileComplete = (result: { id: string; report?: typeof filesToAnalyze[0]['report']; error?: string; status: FileStatus; cached?: boolean }) => {
                onUpdate(prevFiles =>
                    prevFiles.map(df => {
                        if (df.id === result.id) {
                            if (result.report) {
                                // Track successful analysis
                                if (analytics?.trackAnalysisComplete) {
                                    analytics.trackAnalysisComplete(true, df.dumpType);
                                }
                                return {
                                    ...df,
                                    status: FileStatus.ANALYZED,
                                    report: result.report,
                                    cached: result.cached || false
                                };
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
            };

            // Process files in parallel - results stream to UI via onFileComplete
            await analyzeDumpFiles(filesToAnalyze, onProgress, onFileComplete);
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
            setProgress(null);
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
        progress,
        error,
        setError,
        analyzeFiles,
        updateAdvancedAnalysis
    };
};