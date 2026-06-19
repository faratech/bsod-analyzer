/**
 * WinDBG Server Integration Service
 *
 * This service handles uploading .dmp files to the WinDBG analysis server
 * via our backend proxy, polling for completion, and downloading the results.
 *
 * All requests go through our backend to keep the API key secure.
 */

import xxhash from 'xxhash-wasm';
import { initializeSession, handleSessionError } from '../utils/sessionManager';
import { formatHash64 } from '../shared/hash.js';

// Initialize xxhash
let hasher: Awaited<ReturnType<typeof xxhash>> | null = null;
const hasherReady = xxhash().then(h => {
    hasher = h;
    console.log('[WinDBG] XXHash initialized');
    return h;
});

// Polling configuration - increased intervals to reduce server load
const POLL_INTERVAL_MS = 10000; // Poll every 10 seconds (was 3s, increased to reduce load)
const MAX_POLL_ATTEMPTS = 30; // Max 5 minutes of polling (30 * 10s = 300s), then fallback to local analysis
const UPLOAD_TIMEOUT_MS = 120000; // 2 minute upload timeout (files can be large)
const WINDBG_TOTAL_TIMEOUT_MS = 300000; // 5 minute hard timeout for entire WinDBG process

export interface WinDBGUploadResponse {
    success: boolean;
    message?: string;
    cached?: boolean;
    cachedAnalysis?: string;
    cachedSignal?: string;
    cachedStructured?: Record<string, unknown>;
    data?: {
        uid: string;
        filename: string;
        size: number;
        status: 'pending' | 'processing' | 'completed' | 'failed';
        queue_position: number;
        total_pending: number;
    };
    error?: string;
    code?: string;
}

export interface WinDBGStatusResponse {
    success: boolean;
    message?: string;
    data?: {
        uid: string;
        status: 'pending' | 'processing' | 'completed' | 'failed';
        created_at: number;
        started_at?: number;
        completed_at?: number;
        analysis_available?: boolean;
        output_file_size?: number;
        processing_time_seconds?: number;
        error_message?: string;
        queue_position?: number;
    };
    error?: string;
    code?: string;
}

export interface WinDBGDownloadResponse {
    success: boolean;
    analysisText?: string;
    analysisSignalText?: string;
    structured?: Record<string, unknown>;
    error?: string;
}

export interface WinDBGAnalysisResult {
    success: boolean;
    analysisText: string;
    analysisSignalText?: string;
    structured?: Record<string, unknown>;
    processingTime?: number;
    error?: string;
    fileHash?: string; // The xxhash64 of the file, used for cache key consistency
    cached?: boolean; // True if WinDBG result was served from cache
    errorCode?: string;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isBusyError(error: unknown): boolean {
    const err = error as Error & { code?: string };
    return err?.code === 'WINDBG_UPLOAD_BUSY' || /Server is busy/i.test(err?.message || '');
}

/**
 * Generate UID from file content hash
 * Using xxhash64 for speed with large dump files
 */
export async function generateFileHash(file: File): Promise<string> {
    const activeHasher = hasher ?? await hasherReady;
    const streamingHasher = activeHasher.create64();
    const chunkSize = 2 * 1024 * 1024; // 2MB chunk size
    let offset = 0;

    while (offset < file.size) {
        const slice = file.slice(offset, offset + chunkSize);
        const buffer = await slice.arrayBuffer();
        streamingHasher.update(new Uint8Array(buffer));
        offset += chunkSize;
    }

    const hashVal = streamingHasher.digest();
    return formatHash64(hashVal);
}

/**
 * Check cache status for multiple files before upload
 * Returns a map of file hash -> cached status
 */
export async function checkCacheStatus(files: File[]): Promise<Map<File, { hash: string; cached: boolean }>> {
    const results = new Map<File, { hash: string; cached: boolean }>();

    if (files.length === 0) {
        return results;
    }

    try {
        // Generate hashes for all files in parallel
        const hashPromises = files.map(async (file) => ({
            file,
            hash: await generateFileHash(file)
        }));
        const fileHashes = await Promise.all(hashPromises);

        // Create a map of hash -> filename for lookup
        const hashes: string[] = [];
        for (const { hash } of fileHashes) {
            hashes.push(hash);
        }

        // Check cache status via API
        const response = await fetch('/api/cache/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ hashes })
        });

        if (!response.ok) {
            if (response.status === 401) {
                const errorData = await response.json().catch(() => ({}));
                handleSessionError(errorData);
            }
            console.warn('[WinDBG] Cache check failed:', response.status);
            // Return all as not cached on error
            for (const { file, hash } of fileHashes) {
                results.set(file, { hash, cached: false });
            }
            return results;
        }

        const data = await response.json();

        if (data.success && data.cached) {
            for (const { file, hash } of fileHashes) {
                results.set(file, { hash, cached: data.cached[hash] || false });
            }

            const cachedCount = Object.values(data.cached).filter(Boolean).length;
            console.log(`[WinDBG] Cache check: ${cachedCount}/${files.length} files already cached`);
        } else {
            // Return all as not cached if response format is unexpected
            for (const { file, hash } of fileHashes) {
                results.set(file, { hash, cached: false });
            }
        }

        return results;
    } catch (error) {
        console.error('[WinDBG] Error checking cache status:', error);
        // Return empty map on error - will just proceed without cache info
        return results;
    }
}


/**
 * Upload a .dmp file to the WinDBG server via our backend
 */
export async function uploadToWinDBG(
    file: File,
    onUploadProgress?: (percent: number) => void
): Promise<WinDBGUploadResponse> {
    // Use file hash as UID for deterministic caching
    const uid = await generateFileHash(file);

    console.log(`[WinDBG] Uploading ${file.name} with file hash UID: ${uid}`);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('uid', uid);

    // Use XMLHttpRequest for upload progress events
    const result = await new Promise<WinDBGUploadResponse>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/windbg/upload');
        xhr.withCredentials = true;
        xhr.timeout = UPLOAD_TIMEOUT_MS;

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                onUploadProgress?.(Math.round((e.loaded / e.total) * 100));
            }
        };

        xhr.onload = () => {
            try {
                const data: WinDBGUploadResponse = JSON.parse(xhr.responseText);
                if (xhr.status === 401) {
                    handleSessionError(data as unknown as { code?: string; [key: string]: unknown });
                }
                resolve(data);
            } catch {
                reject(new Error('Invalid response from upload endpoint'));
            }
        };

        xhr.onerror = () => reject(new Error('Upload network error'));
        xhr.ontimeout = () => reject(new Error('Upload timed out'));

        xhr.send(formData);
    });

    if (!result.success) {
        const error = new Error(result.error || 'Upload failed') as Error & { code?: string };
        error.code = result.code;
        throw error;
    }

    // Handle cached response - include uid for cache key consistency
    if (result.cached && result.cachedAnalysis) {
        console.log(`[WinDBG] Cache HIT - using cached analysis for ${file.name}`);
        return { ...result, data: { ...result.data, uid } as WinDBGUploadResponse['data'] };
    }

    console.log(`[WinDBG] Upload successful. Queue position: ${result.data?.queue_position}`);
    return { ...result, data: { ...result.data!, uid } };
}

/**
 * Poll the status endpoint until the analysis is complete
 */
export async function pollStatus(uid: string): Promise<WinDBGStatusResponse> {
    let attempts = 0;
    let authRefreshRetries = 0;

    while (attempts < MAX_POLL_ATTEMPTS) {
        attempts++;

        try {
            console.log(`[WinDBG] Polling status (attempt ${attempts}/${MAX_POLL_ATTEMPTS})...`);

            const response = await fetch(`/api/windbg/status?uid=${encodeURIComponent(uid)}`, {
                credentials: 'include'
            });

            if (!response.ok) {
                if (response.status === 401 && authRefreshRetries < 1) {
                    let errorData: any = {};
                    try { errorData = await response.json(); } catch {}
                    if (handleSessionError(errorData)) {
                        console.log('[WinDBG] Session expired during poll, re-initializing...');
                        const refreshed = await initializeSession(true);
                        if (refreshed) {
                            authRefreshRetries++;
                            continue; // Retry this poll attempt
                        }
                    }
                }
                throw new Error(`Status check failed with HTTP ${response.status}`);
            }

            const result: WinDBGStatusResponse = await response.json();
            authRefreshRetries = 0;

            if (!result.success) {
                throw new Error(result.error || 'Status check failed');
            }

            console.log(`[WinDBG] Status: ${result.data?.status}`);

            if (result.data?.status === 'completed') {
                console.log(`[WinDBG] Analysis completed in ${result.data.processing_time_seconds}s`);
                return result;
            }

            if (result.data?.status === 'failed') {
                throw new Error(result.data.error_message || 'Analysis failed on server');
            }

            // Still pending or processing, wait and poll again
            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

        } catch (error) {
            // On network errors, continue polling unless we've exhausted attempts
            console.error(`[WinDBG] Poll error:`, error);
            if (attempts >= MAX_POLL_ATTEMPTS) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        }
    }

    throw new Error('Analysis timed out - max polling attempts reached');
}

/**
 * Download the analysis result from the WinDBG server via our backend
 */
export async function downloadAnalysis(uid: string): Promise<{
    analysisText: string;
    analysisSignalText?: string;
    structured?: Record<string, unknown>;
}> {
    console.log(`[WinDBG] Downloading analysis for UID: ${uid}`);

    let response = await fetch(`/api/windbg/download?uid=${encodeURIComponent(uid)}`, {
        credentials: 'include'
    });

    // Handle session expiry during download
    if (response.status === 401) {
        let errorData: any = {};
        try { errorData = await response.json(); } catch {}
        if (handleSessionError(errorData)) {
            console.log('[WinDBG] Session expired during download, re-initializing...');
            const refreshed = await initializeSession(true);
            if (refreshed) {
                response = await fetch(`/api/windbg/download?uid=${encodeURIComponent(uid)}`, {
                    credentials: 'include'
                });
            }
        }
    }

    if (!response.ok) {
        throw new Error(`Download failed with HTTP ${response.status}`);
    }

    const result: WinDBGDownloadResponse = await response.json();

    if (!result.success || !result.analysisText) {
        throw new Error(result.error || 'Download failed');
    }

    console.log(`[WinDBG] Downloaded ${result.analysisText.length} bytes of analysis; AI signal ${result.analysisSignalText?.length || 0} bytes`);
    return {
        analysisText: result.analysisText,
        analysisSignalText: result.analysisSignalText,
        structured: result.structured
    };
}

/**
 * Full WinDBG analysis pipeline:
 * 1. Upload the file
 * 2. Poll for completion
 * 3. Download the analysis
 *
 * @param file The .dmp file to analyze
 * @param onProgress Optional callback for progress updates
 * @returns The analysis result or throws an error
 */
export async function analyzeWithWinDBG(
    file: File,
    onProgress?: (stage: 'uploading' | 'queued' | 'processing' | 'downloading' | 'complete', message: string) => void,
    onUploadProgress?: (percent: number) => void
): Promise<WinDBGAnalysisResult> {
    // Hard timeout wrapper - 5 minute max for entire WinDBG process
    const timeoutPromise = new Promise<WinDBGAnalysisResult>((_, reject) => {
        setTimeout(() => {
            reject(new Error('WinDBG analysis timed out after 5 minutes'));
        }, WINDBG_TOTAL_TIMEOUT_MS);
    });

    const analysisPromise = (async (): Promise<WinDBGAnalysisResult> => {
    try {
        // Stage 1: Upload
        onProgress?.('uploading', `Uploading ${file.name} to WinDBG server...`);
        let uploadResult: WinDBGUploadResponse | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                uploadResult = await uploadToWinDBG(file, onUploadProgress);
                break;
            } catch (error) {
                if (!isBusyError(error) || attempt === 2) {
                    throw error;
                }
                const delayMs = 1500 * (attempt + 1);
                onProgress?.('queued', `WinDBG server is busy, retrying upload in ${Math.round(delayMs / 1000)}s...`);
                await sleep(delayMs);
            }
        }

        if (!uploadResult) {
            throw new Error('Upload failed');
        }

        // Handle cached response - skip polling and download
        if (uploadResult.cached && uploadResult.cachedAnalysis) {
            onProgress?.('complete', 'Using cached WinDBG analysis');
            return {
                success: true,
                analysisText: uploadResult.cachedAnalysis,
                analysisSignalText: uploadResult.cachedSignal,
                structured: uploadResult.cachedStructured,
                fileHash: uploadResult.data?.uid,
                cached: true
            };
        }

        if (!uploadResult.data) {
            throw new Error('Upload failed - no data returned');
        }

        const uid = uploadResult.data.uid;

        // Stage 2: Poll for completion
        onProgress?.('queued', `Queued for analysis (position ${uploadResult.data.queue_position})`);

        let lastStatus = 'pending';
        let statusResult: WinDBGStatusResponse | null = null;
        let attempts = 0;
        let authRefreshRetries = 0;

        while (attempts < MAX_POLL_ATTEMPTS) {
            attempts++;
            console.log(`[WinDBG] Polling attempt ${attempts}/${MAX_POLL_ATTEMPTS}...`);

            // Add cache-busting timestamp to prevent browser/CDN caching
            const cacheBuster = Date.now();
            const response = await fetch(`/api/windbg/status?uid=${encodeURIComponent(uid)}&_t=${cacheBuster}`, {
                credentials: 'include',
                cache: 'no-store'
            });

            console.log(`[WinDBG] Poll response status: ${response.status}`);

            if (!response.ok) {
                if (response.status === 401 && authRefreshRetries < 1) {
                    let errorData: any = {};
                    try { errorData = await response.json(); } catch {}
                    if (handleSessionError(errorData)) {
                        console.log('[WinDBG] Session expired during poll, re-initializing...');
                        const refreshed = await initializeSession(true);
                        if (refreshed) {
                            authRefreshRetries++;
                            // Don't count this as a poll attempt, retry immediately
                            attempts--;
                            continue;
                        }
                    }
                }
                throw new Error(`Status check failed with HTTP ${response.status}`);
            }

            const result: WinDBGStatusResponse = await response.json();
            authRefreshRetries = 0;
            console.log(`[WinDBG] Poll result:`, result.data?.status);

            if (!result.success) {
                console.error('[WinDBG] Poll failed:', result.error);
                throw new Error(result.error || 'Status check failed');
            }

            // Update progress based on current status
            if (result.data?.status) {
                if (result.data.status !== lastStatus) {
                    lastStatus = result.data.status;
                    console.log(`[WinDBG] Status changed to: ${lastStatus}`);
                }
                if (result.data.status === 'processing') {
                    onProgress?.('processing', 'WinDBG is analyzing your dump file...');
                } else if (result.data.status === 'pending') {
                    const queuePos = result.data.queue_position;
                    const elapsed = attempts * 10;
                    if (queuePos !== undefined && queuePos > 0) {
                        onProgress?.('queued', `Queued for analysis (position ${queuePos}) — ${elapsed}s elapsed`);
                    } else {
                        onProgress?.('queued', `Waiting for WinDBG server... (${elapsed}s)`);
                    }
                }
            }

            if (result.data?.status === 'completed') {
                console.log('[WinDBG] Analysis completed, proceeding to download');
                statusResult = result;
                break;
            }

            if (result.data?.status === 'failed') {
                throw new Error(result.data.error_message || 'Analysis failed on server');
            }

            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        }

        if (!statusResult) {
            throw new Error('WinDBG analysis timed out after 5 minutes - falling back to local analysis');
        }

        // Stage 3: Download the analysis
        onProgress?.('downloading', 'Downloading WinDBG analysis...');
        const downloadedAnalysis = await downloadAnalysis(uid);

        onProgress?.('complete', 'WinDBG analysis complete');

        return {
            success: true,
            analysisText: downloadedAnalysis.analysisText,
            analysisSignalText: downloadedAnalysis.analysisSignalText,
            structured: downloadedAnalysis.structured,
            processingTime: statusResult.data?.processing_time_seconds,
            fileHash: uid
        };

	    } catch (error) {
	        console.error('[WinDBG] Analysis failed:', error);
	        const err = error as Error & { code?: string };
	        return {
	            success: false,
	            analysisText: '',
	            error: err.message,
	            errorCode: err.code
	        };
	    }
    })();

    // Race between analysis and timeout
    try {
        return await Promise.race([analysisPromise, timeoutPromise]);
	    } catch (error) {
	        console.error('[WinDBG] Analysis timed out or failed:', error);
	        const err = error as Error & { code?: string };
	        return {
	            success: false,
	            analysisText: '',
	            error: err.message,
	            errorCode: err.code
	        };
	    }
}
