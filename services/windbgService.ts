/**
 * WinDBG Server Integration Service
 *
 * This service handles uploading .dmp files to the WinDBG analysis server
 * via our backend proxy, polling for completion, and downloading the results.
 *
 * All requests go through our backend to keep the API key secure.
 */

import xxhash from 'xxhash-wasm';

// Initialize xxhash
let hasher: Awaited<ReturnType<typeof xxhash>> | null = null;
xxhash().then(h => {
    hasher = h;
    console.log('[WinDBG] XXHash initialized');
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
    data?: {
        uid: string;
        filename: string;
        size: number;
        status: 'pending' | 'processing' | 'completed' | 'failed';
        queue_position: number;
        total_pending: number;
    };
    error?: string;
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
    };
    error?: string;
}

export interface WinDBGDownloadResponse {
    success: boolean;
    analysisText?: string;
    error?: string;
}

export interface WinDBGAnalysisResult {
    success: boolean;
    analysisText: string;
    processingTime?: number;
    error?: string;
}

/**
 * Generate UID from file content hash
 * Using xxhash64 for speed with large dump files
 */
async function generateFileHash(file: File): Promise<string> {
    const buffer = await file.arrayBuffer();
    const data = new Uint8Array(buffer);

    if (hasher) {
        // Convert to string for xxhash
        const binaryString = Array.from(data).map(b => String.fromCharCode(b)).join('');
        return hasher.h64ToString(binaryString);
    }

    // Fallback if xxhash not initialized (shouldn't happen)
    console.warn('[WinDBG] XXHash not ready, using fallback');
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
        hash = ((hash << 5) - hash) + data[i];
        hash |= 0;
    }
    return Math.abs(hash).toString(16);
}

/**
 * Convert File to base64 string
 */
async function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result as string;
            // Remove the data URL prefix (e.g., "data:application/octet-stream;base64,")
            const base64 = result.split(',')[1];
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

/**
 * Upload a .dmp file to the WinDBG server via our backend
 */
export async function uploadToWinDBG(file: File): Promise<WinDBGUploadResponse> {
    // Use file hash as UID for deterministic caching
    const uid = await generateFileHash(file);

    console.log(`[WinDBG] Uploading ${file.name} with file hash UID: ${uid}`);

    // Convert file to base64
    const fileData = await fileToBase64(file);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

    try {
        const response = await fetch('/api/windbg/upload', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({
                uid,
                fileData,
                fileName: file.name
            }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        const result: WinDBGUploadResponse = await response.json();

        if (!result.success) {
            throw new Error(result.error || 'Upload failed');
        }

        // Handle cached response
        if (result.cached && result.cachedAnalysis) {
            console.log(`[WinDBG] Cache HIT - using cached analysis for ${file.name}`);
            return result;
        }

        console.log(`[WinDBG] Upload successful. Queue position: ${result.data?.queue_position}`);
        return { ...result, data: { ...result.data!, uid } };

    } catch (error) {
        clearTimeout(timeoutId);
        if ((error as Error).name === 'AbortError') {
            throw new Error('Upload timed out');
        }
        throw error;
    }
}

/**
 * Poll the status endpoint until the analysis is complete
 */
export async function pollStatus(uid: string): Promise<WinDBGStatusResponse> {
    let attempts = 0;

    while (attempts < MAX_POLL_ATTEMPTS) {
        attempts++;

        try {
            console.log(`[WinDBG] Polling status (attempt ${attempts}/${MAX_POLL_ATTEMPTS})...`);

            const response = await fetch(`/api/windbg/status?uid=${encodeURIComponent(uid)}`, {
                credentials: 'include'
            });

            const result: WinDBGStatusResponse = await response.json();

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
export async function downloadAnalysis(uid: string): Promise<string> {
    console.log(`[WinDBG] Downloading analysis for UID: ${uid}`);

    const response = await fetch(`/api/windbg/download?uid=${encodeURIComponent(uid)}`, {
        credentials: 'include'
    });

    const result: WinDBGDownloadResponse = await response.json();

    if (!result.success || !result.analysisText) {
        throw new Error(result.error || 'Download failed');
    }

    console.log(`[WinDBG] Downloaded ${result.analysisText.length} bytes of analysis`);
    return result.analysisText;
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
    onProgress?: (stage: 'uploading' | 'queued' | 'processing' | 'downloading' | 'complete', message: string) => void
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
        const uploadResult = await uploadToWinDBG(file);

        // Handle cached response - skip polling and download
        if (uploadResult.cached && uploadResult.cachedAnalysis) {
            onProgress?.('complete', 'Using cached WinDBG analysis');
            return {
                success: true,
                analysisText: uploadResult.cachedAnalysis
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
            const result: WinDBGStatusResponse = await response.json();
            console.log(`[WinDBG] Poll result:`, result.data?.status);

            if (!result.success) {
                console.error('[WinDBG] Poll failed:', result.error);
                throw new Error(result.error || 'Status check failed');
            }

            // Update progress if status changed
            if (result.data?.status && result.data.status !== lastStatus) {
                lastStatus = result.data.status;
                console.log(`[WinDBG] Status changed to: ${lastStatus}`);
                if (result.data.status === 'processing') {
                    onProgress?.('processing', 'WinDBG is analyzing the dump file...');
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
        const analysisText = await downloadAnalysis(uid);

        onProgress?.('complete', 'WinDBG analysis complete');

        return {
            success: true,
            analysisText,
            processingTime: statusResult.data?.processing_time_seconds
        };

    } catch (error) {
        console.error('[WinDBG] Analysis failed:', error);
        return {
            success: false,
            analysisText: '',
            error: (error as Error).message
        };
    }
    })();

    // Race between analysis and timeout
    try {
        return await Promise.race([analysisPromise, timeoutPromise]);
    } catch (error) {
        console.error('[WinDBG] Analysis timed out or failed:', error);
        return {
            success: false,
            analysisText: '',
            error: (error as Error).message
        };
    }
}

/**
 * Check if the WinDBG server is available via our backend
 */
export async function isWinDBGAvailable(): Promise<boolean> {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        // Try to check status with a dummy UID - if the service is configured, it will respond
        const response = await fetch('/api/windbg/status?uid=health-check', {
            credentials: 'include',
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        // Even a 400 (missing UID) means the service is available
        // Only 503 (not configured) means it's unavailable
        return response.status !== 503;
    } catch {
        return false;
    }
}
