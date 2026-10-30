import { useState, useCallback, useEffect, useRef } from 'react';
import { DumpFile, FileAnalysisResult, FileStatus } from '../types';
import { applyFileResult } from '../utils/fileResult';
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

        // Mark the files as analyzing before the session check, which can
        // take seconds (Turnstile): from here on they are no longer offered
        // for removal, so a file the user removed is never uploaded (#380).
        const ids = new Set(filesToAnalyze.map(df => df.id));
        onUpdate(prevFiles =>
            prevFiles.map(df => (ids.has(df.id) ? { ...df, status: FileStatus.ANALYZING } : df))
        );

        const sessionReady = await initializeSession(true);
        // Superseded meanwhile (a retry, or the session was invalidated):
        // whoever superseded this run settled its files.
        if (runIdRef.current !== runId) return;
        if (!sessionReady) {
            setIsAnalyzing(false);
            abortRef.current = null;
            setError('Security check expired. Please complete Turnstile again, then retry analysis.');
            onUpdate(prevFiles =>
                prevFiles.map(df =>
                    ids.has(df.id) && df.status === FileStatus.ANALYZING ? { ...df, status: FileStatus.PENDING } : df
                )
            );
            return;
        }

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
            const onFileComplete = (result: FileAnalysisResult) => {
                if (runIdRef.current !== runId) return;
                onUpdate(prevFiles =>
                    prevFiles.map(df => {
                        if (df.id !== result.id) return df;
                        // Track the analysis outcome
                        analytics?.trackAnalysisComplete?.(Boolean(result.report), df.dumpType);
                        return applyFileResult(df, result);
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

        // Set the file to ANALYZING before the session check, which can take
        // seconds (Turnstile): from here on its card offers no Remove and
        // Clear finished keeps it, so a removed file is never uploaded (#380).
        // The batch this retry just aborted was interrupted mid-flight, and
        // its completion callbacks are now runId-stale: settle every other
        // ANALYZING file so the new single-file run does not leave them stuck
        // (issue #119).
        onUpdate(prevFiles =>
            prevFiles.map(df => {
                if (df.id === fileId) {
                    return { ...df, status: FileStatus.ANALYZING, error: undefined };
                }
                if (df.status === FileStatus.ANALYZING) {
                    return { ...df, status: FileStatus.ERROR, error: 'Analysis cancelled' };
                }
                return df;
            })
        );
        setIsAnalyzing(true);
        clearError();

        const sessionReady = await initializeSession(true);
        // Superseded meanwhile (another retry or analysis, or the session was
        // invalidated): whoever superseded this run settled its file.
        if (runIdRef.current !== runId) return;
        if (!sessionReady) {
            abortRef.current = null;
            setError('Security check expired. Please complete Turnstile again, then retry analysis.');
            // Every completion path of the aborted run is guarded by its
            // now-stale runId, so close out the state here — otherwise
            // isAnalyzing sticks true and files stay ANALYZING (issue #119).
            // The retried file goes back to its failure, still removable.
            setIsAnalyzing(false);
            setProgress(null);
            onUpdate(prevFiles =>
                prevFiles.map(df =>
                    df.status === FileStatus.ANALYZING
                        ? { ...df, status: FileStatus.ERROR, error: df.id === fileId ? (fileToRetry.error ?? 'Analysis cancelled') : 'Analysis cancelled' }
                        : df
                )
            );
            return;
        }

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

            const onFileComplete = (result: FileAnalysisResult) => {
                if (runIdRef.current !== runId) return;
                onUpdate(prevFiles =>
                    prevFiles.map(df => {
                        if (df.id !== result.id) return df;
                        analytics?.trackAnalysisComplete?.(Boolean(result.report), df.dumpType);
                        // Keeps or drops the WinDBG result kept after an AI-only
                        // failure (issue #331).
                        return applyFileResult(df, result);
                    })
                );
            };

            // Re-analyze just this one file. A WinDBG result kept after an
            // AI-only failure (fileToRetry.windbgResult) makes this run only
            // the AI step, with no upload (issue #331).
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
