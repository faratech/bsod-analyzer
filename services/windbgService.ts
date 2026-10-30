/**
 * WinDBG Server Integration Service
 *
 * This service handles uploading .dmp files to the WinDBG analysis server
 * via our backend proxy, polling for completion, and downloading the results.
 *
 * All requests go through our backend to keep the API key secure.
 */

import { dataUseHeaders } from '../utils/dataUse';
import { initializeSession, handleSessionError } from '../utils/sessionManager';
import { sha256Hex } from '../shared/hash.js';

// Polling configuration - increased intervals to reduce server load.
// The upstream API allows MAX_JOB_DURATION=360s per job on top of unbounded
// queue wait, so a 5-minute budget used to abandon jobs that were still going
// to complete successfully (and cache their results).
const POLL_INTERVAL_MS = 10000; // Poll every 10 seconds (was 3s, increased to reduce load)
const MAX_POLL_ATTEMPTS = 60; // Max 10 minutes of polling (60 * 10s = 600s), then fallback to local analysis
// The upload is bounded by inactivity, not by a total timer (#234): a large
// dump on a slow uplink may take minutes to send, which is fine while bytes keep
// moving. Once the body is sent, the server still buffers it and submits it to
// WinDBG under its own WINDBG_UPLOAD_TIMEOUT_MS (240 s), so the response gets a
// separate budget above that.
const UPLOAD_INACTIVITY_TIMEOUT_MS = 60000; // no upload progress for 60 s
const UPLOAD_RESPONSE_TIMEOUT_MS = 300000; // server submit budget (240 s) + margin
// Hard budget for polling + download, armed once the upload has answered
// (#278). The upload phase gets its own hard budget scaled by file size, so a
// slow but progressing upload is not cut off while a pathologically slow one
// is still aborted. Either budget aborts the in-flight request when it fires.
const WINDBG_TOTAL_TIMEOUT_MS = 660000; // poll budget (600 s) + download + margin
const MIN_UPLOAD_BYTES_PER_SECOND = 32 * 1024; // slowest uplink the upload budget allows for

function uploadPhaseBudgetMs(fileSize: number): number {
    return WINDBG_TOTAL_TIMEOUT_MS + Math.ceil((fileSize / MIN_UPLOAD_BYTES_PER_SECOND) * 1000);
}
// The backend answers transient upstream trouble with 502/503/504 and the poll
// limiter with 429. Those are retried on the next poll (and a few times for the
// download) instead of abandoning a WinDBG job that is still running upstream.
const TRANSIENT_HTTP_STATUSES = new Set([429, 502, 503, 504]);
// The upload endpoint's transient failures: gateway errors, and the edge's 52x
// pages (524 = Cloudflare gave up waiting for the origin, #276), which arrive
// as HTML rather than JSON.
const TRANSIENT_UPLOAD_CODE = 'WINDBG_UPLOAD_TRANSIENT';
function isTransientUploadStatus(status: number): boolean {
    return status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530);
}
// The upload route answers a submit slower than its response budget with a
// retryable 504 WINDBG_UPLOAD_TIMEOUT and Retry-After: 15; a retry of the same
// dump joins or adopts the server-side job (#276, docs/TIMEOUT_CONTRACT.md).
// Those, the transient gateway failures and any answer marked retryable are
// retried a bounded number of times, inside the upload-phase budget (#307).
const MAX_RETRYABLE_UPLOAD_RETRIES = 2;
const MAX_BUSY_UPLOAD_RETRIES = 2;
const UPLOAD_RETRY_DEFAULT_DELAY_MS = 15000;
const UPLOAD_RETRY_MAX_DELAY_MS = 30000;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAY_MS = 3000;

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
        queue_position?: number;
        total_pending: number;
        handle?: string;
    };
    error?: string;
    code?: string;
    retryable?: boolean;
}

type UploadError = Error & { code?: string; retryable?: boolean; retryAfterMs?: number };

// Retry-After as delta-seconds or an HTTP date; undefined when absent or invalid.
function parseRetryAfterMs(value: string | null | undefined): number | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
    const at = Date.parse(trimmed);
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function readRetryAfterMs(xhr: XMLHttpRequest): number | undefined {
    try {
        return parseRetryAfterMs(xhr.getResponseHeader('Retry-After'));
    } catch {
        return undefined;
    }
}

function isRetryableUploadError(error: unknown): boolean {
    const err = error as UploadError;
    return err?.retryable === true || err?.code === 'WINDBG_UPLOAD_TIMEOUT' || err?.code === TRANSIENT_UPLOAD_CODE;
}

// The upload route's answer when WinDbg-API took nothing and asked to come
// back later (queue full, storage pressure; issue #327).
const RETRY_LATER_UPLOAD_CODE = 'WINDBG_UPLOAD_RETRY_LATER';
const REJECTED_UPLOAD_CODE = 'WINDBG_UPLOAD_REJECTED';

// The WinDBG failure as quoted in the AI fallback prompt (issue #327): only
// the upload route's WINDBG_UPLOAD_REJECTED says the dump itself was refused;
// any other failure text that reads like a rejection is replaced so the model
// is not told a valid dump was rejected.
export function describeWinDbgFailureForPrompt(failure: unknown): string {
    const err = failure as { message?: unknown; code?: unknown } | null | undefined;
    const message = failure instanceof Error
        ? failure.message
        : typeof failure === 'string' ? failure : typeof err?.message === 'string' ? err.message : '';
    if (!message) return 'Unknown WinDBG failure';
    if (err?.code !== REJECTED_UPLOAD_CODE && /reject|supported Windows crash dump/i.test(message)) {
        return 'The WinDBG server could not complete this analysis (a server-side or temporary failure; not a finding about the dump).';
    }
    return message;
}

function uploadRetryDelayMs(error: unknown): number {
    const requested = (error as UploadError)?.retryAfterMs;
    const delay = typeof requested === 'number' && Number.isFinite(requested) ? requested : UPLOAD_RETRY_DEFAULT_DELAY_MS;
    return Math.min(Math.max(delay, 1000), UPLOAD_RETRY_MAX_DELAY_MS);
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
        error_category?: string;
        raw_status?: string;
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
    fileHash?: string; // SHA-256 of the file (the server's file identity)
    cached?: boolean; // True if WinDBG result was served from cache
    errorCode?: string;
    errorCategory?: string; // Upstream failure category (cdb|timeout|upload|watchdog|...)
}

export interface CachedAnalysisResponse {
    success: boolean;
    cached?: boolean;
    windbgAnalysis?: string | null;
    analysisSignalText?: string | null;
    structured?: Record<string, unknown> | null;
    aiReport?: unknown | null;
    fileHash?: string;
    error?: string;
    code?: string;
}

// file hash -> signed handle from the upload response. The handle proves this
// session uploaded the file (and carries the upstream WinDBG job id), so poll,
// download and cache reads succeed on whichever server instance answers.
const fileHandles = new Map<string, string>();

export function getFileHandle(hash: string | undefined): string | undefined {
    return hash ? fileHandles.get(hash) : undefined;
}

function handleQuery(hash: string): string {
    const handle = fileHandles.get(hash);
    return handle ? `&h=${encodeURIComponent(handle)}` : '';
}

// Resolves after `ms`, or as soon as `signal` aborts (callers then check it).
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise(resolve => {
        if (signal?.aborted) {
            resolve();
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

// Only the code: every busy producer (the cap gate, the submitter, the
// concurrency limiter) sets it, and the retry-later answer's "server is busy"
// wording must not spend the busy budget on top of the retryable one (#344).
function isBusyError(error: unknown): boolean {
    return (error as { code?: string } | null)?.code === 'WINDBG_UPLOAD_BUSY';
}

/**
 * Generate UID from file content hash: SHA-256, the same value the server
 * computes for the upload (shared/hash.js, issue #146). WebCrypto hashes the
 * whole file at once; uploads are capped at 100 MB, and callers hash one file
 * at a time to bound memory.
 */
export async function generateFileHash(file: File): Promise<string> {
    return sha256Hex(await file.arrayBuffer());
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

    let fileHashes: Array<{ file: File; hash: string }> = [];
    try {
        // One file at a time: each SHA-256 holds its whole file in memory
        for (const file of files) {
            fileHashes.push({ file, hash: await generateFileHash(file) });
        }

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
            body: JSON.stringify({
                hashes,
                handles: Object.fromEntries(
                    hashes.filter(hash => fileHandles.has(hash)).map(hash => [hash, fileHandles.get(hash)])
                )
            })
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
        // Keep the hash-complete map on thrown errors too, so callers still
        // get fileHash attached and downstream hash-keyed flows keep working.
        for (const { file, hash } of fileHashes) {
            if (!results.has(file)) results.set(file, { hash, cached: false });
        }
        return results;
    }
}

/**
 * Fetch a previously cached analysis by file hash. This is intentionally
 * hash-only after session validation so known cached files can load without a
 * WinDBG upload.
 */
export async function getCachedAnalysisByHash(hash: string): Promise<CachedAnalysisResponse | null> {
    let response = await fetch(`/api/cache/get?hash=${encodeURIComponent(hash)}${handleQuery(hash)}`, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store'
    });

    if (response.status === 401) {
        const errorData = await response.json().catch(() => ({}));
        if (handleSessionError(errorData)) {
            const refreshed = await initializeSession(true);
            if (refreshed) {
                response = await fetch(`/api/cache/get?hash=${encodeURIComponent(hash)}${handleQuery(hash)}`, {
                    method: 'GET',
                    credentials: 'include',
                    cache: 'no-store'
                });
            }
        }
    }

    if (!response.ok) {
        console.warn('[WinDBG] Cached analysis fetch failed:', response.status);
        return null;
    }

    const data: CachedAnalysisResponse = await response.json();
    if (data.success && data.cached) {
        return data;
    }
    return null;
}


// Cancellation marker for a superseded analysis run. Callers (the per-run
// AbortController in useAnalysis) drop stale results via the runId guard, so
// this only needs to stop the work, not surface an error banner.
function createCancelledError(): Error & { code: string } {
    const error = new Error('Analysis cancelled') as Error & { code: string };
    error.name = 'AbortError';
    error.code = 'ABORTED';
    return error;
}

/**
 * Upload a .dmp file to the WinDBG server via our backend
 */
export async function uploadToWinDBG(
    file: File,
    onUploadProgress?: (percent: number) => void,
    signal?: AbortSignal
): Promise<WinDBGUploadResponse> {
    // Use file hash as UID for deterministic caching
    const uid = await generateFileHash(file);

    console.log(`[WinDBG] Uploading ${file.name} with file hash UID: ${uid}`);

    // uid goes before the file so it is parsed before the (large) file part
    // ends; a trailing field can land in a later network read (#244).
    const formData = new FormData();
    formData.append('uid', uid);
    formData.append('file', file);

    // Use XMLHttpRequest for upload progress events
    let retryAfterMs: number | undefined;
    const result = await new Promise<WinDBGUploadResponse>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/windbg/upload');
        xhr.withCredentials = true;
        for (const [name, value] of Object.entries(dataUseHeaders())) {
            xhr.setRequestHeader(name, value);
        }
        // Advisory: lets the server admit a retry that joins or adopts this
        // dump's running submit at the per-instance cap before it reads the
        // body (#338). The server recomputes the hash from the body.
        xhr.setRequestHeader('X-File-Hash', uid);

        let timer: ReturnType<typeof setTimeout> | undefined;
        const clearTimer = () => {
            if (timer !== undefined) clearTimeout(timer);
            timer = undefined;
        };
        const armTimer = (ms: number) => {
            clearTimer();
            timer = setTimeout(() => {
                timer = undefined;
                signal?.removeEventListener('abort', onAbort);
                reject(new Error('Upload timed out'));
                xhr.abort();
            }, ms);
        };

        // Cancel the request the moment the owning analysis run is cancelled:
        // a zombie upload holds a backend concurrency slot (and a WinDBG server
        // job) until it times out, which starves legitimate retries.
        const onAbort = () => {
            clearTimer();
            xhr.abort();
            reject(createCancelledError());
        };

        xhr.upload.onprogress = (e) => {
            armTimer(UPLOAD_INACTIVITY_TIMEOUT_MS);
            if (e.lengthComputable) {
                onUploadProgress?.(Math.round((e.loaded / e.total) * 100));
            }
        };

        // Body fully sent: now wait for the server's buffer + upstream submit.
        xhr.upload.onload = () => {
            armTimer(UPLOAD_RESPONSE_TIMEOUT_MS);
        };

        xhr.onload = () => {
            clearTimer();
            signal?.removeEventListener('abort', onAbort);
            retryAfterMs = readRetryAfterMs(xhr);
            let data: WinDBGUploadResponse | null = null;
            try {
                data = JSON.parse(xhr.responseText);
            } catch {
                data = null;
            }
            if (!data || typeof data !== 'object') {
                // An HTML error page from the edge (524 when the origin took
                // longer than 100 s) or a proxy: transient, not malformed (#276).
                if (isTransientUploadStatus(xhr.status) || xhr.status >= 500) {
                    const error = new Error(
                        `The WinDBG server did not answer the upload in time (HTTP ${xhr.status}). Please try again in a few minutes.`
                    ) as UploadError;
                    error.code = TRANSIENT_UPLOAD_CODE;
                    error.retryAfterMs = retryAfterMs;
                    reject(error);
                } else {
                    reject(new Error('Invalid response from upload endpoint'));
                }
                return;
            }
            if (xhr.status === 401) {
                handleSessionError(data as unknown as { code?: string; [key: string]: unknown });
            }
            // Keep the server's own code (e.g. a retryable 504 or a 422
            // WINDBG_UPLOAD_REJECTED). A gateway 5xx without one is transient
            // only when it says so: the upload route marks the upstream
            // failures that clear up on their own retryable, and a permanent
            // one must not re-send the whole dump (#325).
            if (!data.success && !data.code && isTransientUploadStatus(xhr.status) && data.retryable === true) {
                data = { ...data, code: TRANSIENT_UPLOAD_CODE };
            }
            resolve(data);
        };

        xhr.onerror = () => {
            clearTimer();
            signal?.removeEventListener('abort', onAbort);
            reject(new Error('Upload network error'));
        };
        xhr.ontimeout = () => {
            clearTimer();
            signal?.removeEventListener('abort', onAbort);
            reject(new Error('Upload timed out'));
        };
        xhr.onabort = () => {
            clearTimer();
            signal?.removeEventListener('abort', onAbort);
            reject(createCancelledError());
        };

        if (signal?.aborted) {
            onAbort();
            return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        xhr.send(formData);
        armTimer(UPLOAD_INACTIVITY_TIMEOUT_MS);
    });

    if (!result.success) {
        const error = new Error(result.error || 'Upload failed') as UploadError;
        error.code = result.code;
        error.retryable = result.retryable === true;
        error.retryAfterMs = retryAfterMs;
        throw error;
    }

    if (result.data?.handle) {
        fileHandles.set(uid, result.data.handle);
    }

    // Handle cached response - always preserve the locally computed uid as the
    // fileHash, even when the server omitted a data object, so the downstream
    // Gemini cache key is never undefined.
    if (result.cached && result.cachedAnalysis) {
        console.log(`[WinDBG] Cache HIT - using cached analysis for ${file.name}`);
        return { ...result, data: { ...(result.data || {}), uid } as WinDBGUploadResponse['data'] };
    }

    console.log(`[WinDBG] Upload successful. Queue position: ${result.data?.queue_position}`);
    return { ...result, data: { ...(result.data || {}), uid } as WinDBGUploadResponse['data'] };
}

/**
 * Download the analysis result from the WinDBG server via our backend
 */
export async function downloadAnalysis(uid: string, signal?: AbortSignal): Promise<{
    analysisText: string;
    analysisSignalText?: string;
    structured?: Record<string, unknown>;
}> {
    console.log(`[WinDBG] Downloading analysis for UID: ${uid}`);

    const fetchDownload = async (): Promise<Response> => {
        for (let attempt = 1; ; attempt++) {
            try {
                const response = await fetch(`/api/windbg/download?uid=${encodeURIComponent(uid)}${handleQuery(uid)}`, {
                    credentials: 'include',
                    signal
                });
                if (!TRANSIENT_HTTP_STATUSES.has(response.status) || attempt >= DOWNLOAD_ATTEMPTS) {
                    return response;
                }
                console.warn(`[WinDBG] Download attempt ${attempt} got HTTP ${response.status}, retrying...`);
            } catch (error) {
                if (signal?.aborted) throw createCancelledError();
                if (attempt >= DOWNLOAD_ATTEMPTS) throw error;
                console.warn(`[WinDBG] Download attempt ${attempt} failed, retrying...`, error);
            }
            await sleep(DOWNLOAD_RETRY_DELAY_MS, signal);
            if (signal?.aborted) throw createCancelledError();
        }
    };

    let response = await fetchDownload();

    // Handle session expiry during download
    if (response.status === 401) {
        let errorData: any = {};
        try { errorData = await response.json(); } catch {}
        if (handleSessionError(errorData)) {
            console.log('[WinDBG] Session expired during download, re-initializing...');
            const refreshed = await initializeSession(true);
            if (refreshed) {
                response = await fetchDownload();
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
    onUploadProgress?: (percent: number) => void,
    signal?: AbortSignal
): Promise<WinDBGAnalysisResult> {
    // Hard timeouts: the upload phase gets a budget scaled by file size, then
    // polling + download get WINDBG_TOTAL_TIMEOUT_MS from when the upload
    // answered (#278). When a budget runs out the internal controller aborts
    // whatever request is in flight (upload XHR, poll, download) so nothing
    // keeps running after the caller fell back to local analysis. The
    // controller also follows the caller's cancel signal.
    const controller = new AbortController();
    const runSignal = controller.signal;
    const onCallerAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', onCallerAbort, { once: true });

    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let rejectTimeout: (error: Error) => void = () => {};
    const timeoutPromise = new Promise<WinDBGAnalysisResult>((_, reject) => {
        rejectTimeout = reject;
    });
    const armTimeout = (ms: number) => {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        timeoutHandle = setTimeout(() => {
            timeoutHandle = undefined;
            timedOut = true;
            rejectTimeout(new Error('WinDBG analysis timed out - falling back to local analysis'));
            controller.abort();
        }, ms);
    };
    const uploadDeadline = Date.now() + uploadPhaseBudgetMs(file.size);
    armTimeout(uploadPhaseBudgetMs(file.size));

    const analysisPromise = (async (): Promise<WinDBGAnalysisResult> => {
    try {
        // Stage 1: Upload
        onProgress?.('uploading', `Uploading ${file.name} to WinDBG server...`);
        let uploadResult: WinDBGUploadResponse | null = null;
        let busyRetries = 0;
        let retryableRetries = 0;
        for (;;) {
            try {
                uploadResult = await uploadToWinDBG(file, onUploadProgress, runSignal);
                break;
            } catch (error) {
                // Busy (the per-instance cap, #314) and retryable answers both
                // wait for the server's Retry-After (#338); a busy answer used
                // to re-send the whole dump after 1.5 s and 3 s.
                const busy = isBusyError(error) && busyRetries < MAX_BUSY_UPLOAD_RETRIES;
                if (!busy && !(isRetryableUploadError(error) && retryableRetries < MAX_RETRYABLE_UPLOAD_RETRIES)) {
                    throw error;
                }
                const delayMs = uploadRetryDelayMs(error);
                // A wait that cannot end inside the upload-phase budget only
                // ends in that budget's timeout: fall back now instead.
                if (Date.now() + delayMs >= uploadDeadline) {
                    throw error;
                }
                const waitSeconds = Math.round(delayMs / 1000);
                if (busy) {
                    busyRetries++;
                    onProgress?.('queued', `WinDBG server is busy, retrying upload in ${waitSeconds}s...`);
                } else {
                    // The submit may still be running server-side: the retry
                    // joins or adopts it rather than starting over.
                    retryableRetries++;
                    onProgress?.('queued', (error as UploadError)?.code === RETRY_LATER_UPLOAD_CODE
                        ? `WinDBG server is busy, retrying upload in ${waitSeconds}s...`
                        : `Still submitting to the WinDBG server, retrying in ${waitSeconds}s...`);
                }
                // The upload-phase budget keeps running; it (or a cancel)
                // wakes this sleep and ends the run.
                await sleep(delayMs, runSignal);
                if (runSignal.aborted) {
                    throw createCancelledError();
                }
                // The whole dump is sent again: the stage, its timer and the
                // percentage bar follow the re-upload (#326).
                onProgress?.('uploading', `Retrying upload of ${file.name}...`);
            }
        }

        if (!uploadResult) {
            throw new Error('Upload failed');
        }

        // The upload answered: polling and download get their own budget.
        if (!timedOut) armTimeout(WINDBG_TOTAL_TIMEOUT_MS);

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
        // Same rule as the poll loop: 0 or a missing position means unknown (#271).
        const initialQueuePos = uploadResult.data.queue_position;
        onProgress?.('queued', initialQueuePos !== undefined && initialQueuePos > 0
            ? `Queued for analysis (position ${initialQueuePos})`
            : 'Waiting for WinDBG server...');

        let lastStatus = 'pending';
        let statusResult: WinDBGStatusResponse | null = null;
        let attempts = 0;
        let authRefreshes = 0;
        const MAX_AUTH_REFRESHES = 2; // hard cap that never replenishes
        let consecutiveFailures = 0;

        while (attempts < MAX_POLL_ATTEMPTS) {
            attempts++;
            if (timedOut) {
                throw new Error('WinDBG analysis timed out - stopping background polling');
            }
            // Cancelled runs stop cooperatively at the next poll boundary (the
            // poll-interval sleep is not abort-woken; ≤POLL_INTERVAL_MS of zombie
            // polling is acceptable, minutes of it is not).
            if (runSignal.aborted) {
                throw createCancelledError();
            }
            console.log(`[WinDBG] Polling attempt ${attempts}/${MAX_POLL_ATTEMPTS}...`);

            // Add cache-busting timestamp to prevent browser/CDN caching
            const cacheBuster = Date.now();
            let response: Response;
            try {
                response = await fetch(`/api/windbg/status?uid=${encodeURIComponent(uid)}${handleQuery(uid)}&_t=${cacheBuster}`, {
                    credentials: 'include',
                    cache: 'no-store',
                    signal: runSignal
                });
            } catch (error) {
                if (runSignal.aborted) throw createCancelledError();
                // Network blip: the upstream job keeps running, so poll again.
                if (++consecutiveFailures > MAX_CONSECUTIVE_POLL_FAILURES) throw error;
                console.warn(`[WinDBG] Poll network error (${consecutiveFailures}/${MAX_CONSECUTIVE_POLL_FAILURES}), retrying...`, error);
                await sleep(POLL_INTERVAL_MS, runSignal);
                continue;
            }

            console.log(`[WinDBG] Poll response status: ${response.status}`);

            if (TRANSIENT_HTTP_STATUSES.has(response.status) && ++consecutiveFailures <= MAX_CONSECUTIVE_POLL_FAILURES) {
                console.warn(`[WinDBG] Poll got HTTP ${response.status} (${consecutiveFailures}/${MAX_CONSECUTIVE_POLL_FAILURES}), retrying...`);
                await sleep(POLL_INTERVAL_MS, runSignal);
                continue;
            }

            if (!response.ok) {
                if (response.status === 401 && authRefreshes < MAX_AUTH_REFRESHES) {
                    let errorData: any = {};
                    try { errorData = await response.json(); } catch {}
                    if (handleSessionError(errorData)) {
                        console.log('[WinDBG] Session expired during poll, re-initializing...');
                        const refreshed = await initializeSession(true);
                        if (refreshed) {
                            authRefreshes++;
                            continue;
                        }
                    }
                }
                throw new Error(`Status check failed with HTTP ${response.status}`);
            }

            consecutiveFailures = 0;
            const result: WinDBGStatusResponse = await response.json();
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
                const failure = new Error(
                    result.data.error_message || 'Analysis failed on server'
                ) as Error & { errorCategory?: string };
                failure.errorCategory = result.data.error_category;
                throw failure;
            }

            await sleep(POLL_INTERVAL_MS, runSignal);
        }

        if (!statusResult) {
            throw new Error(`WinDBG analysis timed out after ${Math.round(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 60000)} minutes - falling back to local analysis`);
        }

        // Stage 3: Download the analysis
        if (timedOut) {
            throw new Error('WinDBG analysis timed out - stopping background download');
        }
        if (runSignal.aborted) {
            throw createCancelledError();
        }
        onProgress?.('downloading', 'Downloading WinDBG analysis...');
        const downloadedAnalysis = await downloadAnalysis(uid, runSignal);

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
	        const err = error as Error & { code?: string; errorCategory?: string };
	        return {
	            success: false,
	            analysisText: '',
	            error: err.message,
	            errorCode: err.code,
	            errorCategory: err.errorCategory
	        };
	    }
    })();

    // Race between analysis and timeout
    try {
        return await Promise.race([analysisPromise, timeoutPromise]);
    } catch (error) {
        console.error('[WinDBG] Analysis timed out or failed:', error);
        const err = error as Error & { code?: string; errorCategory?: string };
        return {
            success: false,
            analysisText: '',
            error: err.message,
            errorCode: err.code,
            errorCategory: err.errorCategory
        };
    } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        signal?.removeEventListener('abort', onCallerAbort);
    }
}
