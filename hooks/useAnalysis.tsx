import { useState, useCallback, useEffect, useRef } from 'react';
import { DumpFile, FileStatus } from '../types';
import { analyzeDumpFiles } from '../services/geminiProxy';
import { useError } from './useError';
import { initializeSession, onSessionInvalid } from '../utils/sessionManager';

export type AnalysisStage = 'uploading' | 'queued' | 'processing' | 'downloading' | 'analyzing' | 'complete';

export interface AnalysisProgress {
    stage: AnalysisStage;
    message: string;
    startTime: number;
    percentage?: number;
}

export const useAnalysis = () => {
    const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
    const [progress, setProgress] = useState<AnalysisProgress | null>(null);
    const { error, setError, clearError } = useError();
    const runIdRef = useRef(0);
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => onSessionInvalid(() => {
        runIdRef.current += 1;
        abortRef.current?.abort();
        setIsAnalyzing(false);
        setProgress(null);
        setError('Security check expired. Please complete Turnstile again, then retry analysis.');
    }), [setError]);

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
        const runId = runIdRef.current + 1;
        runIdRef.current = runId;
        abortRef.current?.abort();
        const abortController = new AbortController();
        abortRef.current = abortController;

        const filesToAnalyze = dumpFiles.filter(df => df.status === FileStatus.PENDING);
        
        if (filesToAnalyze.length === 0) {
            setIsAnalyzing(false);
            abortRef.current = null;
            return;
        }

        const sessionReady = await initializeSession(true);
        if (!sessionReady) {
            setIsAnalyzing(false);
            abortRef.current = null;
            setError('Security check expired. Please complete Turnstile again, then retry analysis.');
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

        const allCached = filesToAnalyze.every(df => df.knownCached && df.fileHash);

        // Initialize progress tracking
        const startTime = Date.now();
        setProgress({
            stage: allCached ? 'downloading' : 'uploading',
            message: allCached ? 'Loading cached analysis...' : 'Preparing analysis...',
            startTime
        });

        try {
            // Track analysis start for each file
            if (analytics?.trackAnalysisStart) {
                filesToAnalyze.forEach(file => {
                    analytics.trackAnalysisStart!(file.dumpType);
                });
            }

            const onProgress = (stage: AnalysisStage, message: string) => {
                if (runIdRef.current !== runId) return;
                setProgress(prev => ({
                    stage,
                    message,
                    startTime,
                    // Clear percentage when moving past upload stage
                    percentage: stage === 'uploading' ? prev?.percentage : undefined
                }));
            };

            // Upload progress callback
            const onUploadProgress = allCached ? undefined : (percent: number) => {
                if (runIdRef.current !== runId) return;
                setProgress(prev => prev ? { ...prev, percentage: percent } : null);
            };

            // Callback to update UI immediately when each file completes
            const onFileComplete = (result: { id: string; report?: typeof filesToAnalyze[0]['report']; error?: string; status: FileStatus; cached?: boolean; analysisMethod?: 'windbg' | 'local' }) => {
                if (runIdRef.current !== runId) return;
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
                                    cached: result.cached || false,
                                    analysisMethod: result.analysisMethod
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
            await analyzeDumpFiles(filesToAnalyze, onProgress, onFileComplete, onUploadProgress, {
                signal: abortController.signal
            });
        } catch (e) {
            if (runIdRef.current !== runId) return;
            console.error("Analysis failed:", e);
            setError('A critical error occurred during analysis.');
            onUpdate(prevFiles =>
                prevFiles.map(df =>
                    df.status === FileStatus.ANALYZING ? { ...df, status: FileStatus.ERROR, error: 'Analysis failed' } : df
                )
            );
        } finally {
            if (runIdRef.current === runId) {
                setIsAnalyzing(false);
                setProgress(null);
                abortRef.current = null;
            }
        }
    }, []);

    const retryFile = useCallback(async (
        fileId: string,
        dumpFiles: DumpFile[],
        onUpdate: (updater: (prevFiles: DumpFile[]) => DumpFile[]) => void,
        analytics?: {
            trackAnalysisStart?: (dumpType: string) => void;
            trackAnalysisComplete?: (success: boolean, dumpType: string) => void;
        }
    ) => {
        const fileToRetry = dumpFiles.find(df => df.id === fileId);
        if (!fileToRetry) return;
        const runId = runIdRef.current + 1;
        runIdRef.current = runId;
        abortRef.current?.abort();
        const abortController = new AbortController();
        abortRef.current = abortController;

        const sessionReady = await initializeSession(true);
        if (!sessionReady) {
            abortRef.current = null;
            setError('Security check expired. Please complete Turnstile again, then retry analysis.');
            return;
        }

        // Reset file status to ANALYZING
        onUpdate(prevFiles =>
            prevFiles.map(df =>
                df.id === fileId
                    ? { ...df, status: FileStatus.ANALYZING, error: undefined }
                    : df
            )
        );

        setIsAnalyzing(true);
        clearError();

        const startTime = Date.now();
        const cachedRetry = !!(fileToRetry.knownCached && fileToRetry.fileHash);
        setProgress({
            stage: cachedRetry ? 'downloading' : 'uploading',
            message: cachedRetry ? 'Loading cached analysis...' : 'Preparing analysis...',
            startTime
        });

        try {
            if (analytics?.trackAnalysisStart) {
                analytics.trackAnalysisStart(fileToRetry.dumpType);
            }

            const onProgress = (stage: AnalysisStage, message: string) => {
                if (runIdRef.current !== runId) return;
                setProgress(prev => ({
                    stage,
                    message,
                    startTime,
                    percentage: stage === 'uploading' ? prev?.percentage : undefined
                }));
            };

            const onUploadProgress = cachedRetry ? undefined : (percent: number) => {
                if (runIdRef.current !== runId) return;
                setProgress(prev => prev ? { ...prev, percentage: percent } : null);
            };

            const onFileComplete = (result: { id: string; report?: typeof fileToRetry['report']; error?: string; status: FileStatus; cached?: boolean; analysisMethod?: 'windbg' | 'local' }) => {
                if (runIdRef.current !== runId) return;
                onUpdate(prevFiles =>
                    prevFiles.map(df => {
                        if (df.id === result.id) {
                            if (result.report) {
                                if (analytics?.trackAnalysisComplete) {
                                    analytics.trackAnalysisComplete(true, df.dumpType);
                                }
                                return {
                                    ...df,
                                    status: FileStatus.ANALYZED,
                                    report: result.report,
                                    cached: result.cached || false,
                                    analysisMethod: result.analysisMethod
                                };
                            }
                            if (analytics?.trackAnalysisComplete) {
                                analytics.trackAnalysisComplete(false, df.dumpType);
                            }
                            return { ...df, status: FileStatus.ERROR, error: result.error || 'Unknown analysis error' };
                        }
                        return df;
                    })
                );
            };

            // Re-analyze just this one file
            const retryDumpFile = { ...fileToRetry, status: FileStatus.PENDING };
            await analyzeDumpFiles([retryDumpFile], onProgress, onFileComplete, onUploadProgress, {
                signal: abortController.signal
            });
        } catch (e) {
            if (runIdRef.current !== runId) return;
            console.error("Retry analysis failed:", e);
            setError('A critical error occurred during analysis retry.');
            onUpdate(prevFiles =>
                prevFiles.map(df =>
                    df.id === fileId && df.status === FileStatus.ANALYZING
                        ? { ...df, status: FileStatus.ERROR, error: 'Retry failed' }
                        : df
                )
            );
        } finally {
            if (runIdRef.current === runId) {
                setIsAnalyzing(false);
                setProgress(null);
                abortRef.current = null;
            }
        }
    }, []);

    return {
        isAnalyzing,
        progress,
        error,
        setError,
        analyzeFiles,
        retryFile
    };
};
