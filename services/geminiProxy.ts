// Proxy to match the original geminiService.ts exactly but route through backend
import { DumpFile, AnalysisReportData, FileStatus, FileAnalysisResult, RetainedWinDbgResult } from '../types';
import { dataUseHeaders } from '../utils/dataUse';
import { sanitizeExtractedContent, validateProcessingTimeout } from '../utils/contentSanitizer';
import { initializeSession, handleSessionError, getSessionGeneration } from '../utils/sessionManager';
import { getStructuredDumpInfo, extractBugCheckInfo, isLegitimateModuleName } from '../utils/dumpParser';
import { parseDumpFile as parseKernelDump, KernelDumpResult } from '../utils/kernelDumpModuleParser';
import { findMatchingPattern, getEnhancedRecommendations, analyzeCrashContext } from '../utils/knownPatterns';
import { getParameterExplanation } from '../utils/crashPatternDatabase';
import { FILE_SIZE_THRESHOLDS, PROCESSING_LIMITS } from '../constants';
import { analyzeMemoryPatterns } from '../utils/memoryPatternAnalyzer';
import { extractDriverVersions, identifyOutdatedDrivers } from '../utils/peParser';
import { MinidumpParser } from '../utils/minidumpStreams.js';
import { formatMachineType } from '../utils/machineType.js';
import { analyzeWithWinDBG, describeWinDbgFailureForPrompt, getCachedAnalysisByHash, getFileHandle, WinDBGAnalysisResult } from './windbgService';
import { LOCAL_DUMP_PREFIX, WINDBG_PREFIX, WINDBG_OUTPUT_MARKER, WINDBG_STRUCTURED_NOTE, WINDBG_RAW_NOTE, wrapWithEvidence } from '../shared/promptTemplates.js';
import {
    mapStructuredSignalToReport,
    mergeReportWithWinDbgFields,
    parseWinDbgOutput
} from '../shared/windbgReportFields.js';
import { getLargeDumpSampleRanges, shouldUseLightweightAiFailover } from '../shared/windbgFailoverPolicy.js';
import { redactPersonalIdentifiers, redactPersonalBytes, collectPersonalNamesFromBytes } from '../shared/promptRedaction.js';
import { isPremiumTier } from './tierState';
import { SSO_ENABLED } from './featureFlags';
import { describeForcedCrash, describeForcedCrashParameters } from '../utils/forcedCrash';
// Define types to match original imports
enum Type {
    STRING = 'string',
    NUMBER = 'number', 
    INTEGER = 'integer',
    BOOLEAN = 'boolean',
    ARRAY = 'array',
    OBJECT = 'object'
}

interface GenerateContentResponse {
    text: string;
    cached?: boolean;
}

interface GenerateContentParams {
    contents: any; // Array of content objects or string
    config?: {
        responseMimeType?: string;
        responseSchema?: any;
        temperature?: number;
        maxOutputTokens?: number;
        topK?: number;
        topP?: number;
    };
    tools?: any[];
    fileHash?: string; // For cache key consistency
    fileHandle?: string; // Signed upload handle proving ownership of fileHash
    signal?: AbortSignal; // The analysis run's signal; never sent in the body
}

// Same marker windbgService uses for a superseded/cancelled run.
function createCancelledError(): Error & { code: string } {
    return Object.assign(new Error('Analysis cancelled'), { name: 'AbortError', code: 'ABORTED' });
}

// Format a bug check code as 0x-prefixed uppercase hex (e.g., 0x0000007E)
function formatBugCheckHex(code: number): string {
    return `0x${code.toString(16).padStart(8, '0').toUpperCase()}`;
}

// AI-hallucinated driver names that must be sanitized from inputs and outputs
const FAKE_DRIVERS = ['wXr', 'wEB', 'vS'] as const;
const FAKE_DRIVER_SYS = FAKE_DRIVERS.map(d => `${d}.sys`);
const FAKE_DRIVER_PATTERN = /\b(wXr|wEB|vS)\.sys\b/gi;

function isTurnstileRequiredError(error: unknown): boolean {
    return error instanceof Error && /turnstile verification required/i.test(error.message);
}

// Create proxy object that mimics GoogleGenAI to avoid minification issues
const createGeminiProxy = () => {
    const generateContent = async (params: GenerateContentParams): Promise<GenerateContentResponse> => {
        let retryCount = 0;
        const MAX_RETRIES = 2;

        const { signal, ...body } = params;

        const makeRequest = async (): Promise<any> => {
            try {
                // A cancelled run must not spend an AI call (issue #235).
                if (signal?.aborted) throw createCancelledError();

                // Log the request size for debugging
                const requestBody = JSON.stringify(body);
                console.log('[GeminiProxy] Request size:', requestBody.length, 'bytes');
                if (requestBody.length > 1000000) {
                    console.warn('[GeminiProxy] Large request size may cause issues');
                }

                const response = await fetch('/api/gemini/generateContent', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...dataUseHeaders(),
                    },
                    credentials: 'include', // Important: include cookies for session
                    body: requestBody,
                    signal
                });

                if (!response.ok) {
                    let errorMessage = `API request failed with status ${response.status}`;
                    let errorData: any = {};

                    // Read the body once: a failed json() consumes the stream,
                    // so an edge HTML page (Cloudflare 52x/403) could never be
                    // read as text afterwards (issues #219, #230).
                    let errorText = '';
                    try {
                        errorText = await response.text();
                    } catch {
                        console.error('[GeminiProxy] Could not read error response');
                    }
                    try {
                        const parsed = JSON.parse(errorText);
                        if (parsed && typeof parsed === 'object') errorData = parsed;
                        console.error('[GeminiProxy] Error response:', errorData);
                    } catch {
                        console.error('[GeminiProxy] Error response text:', errorText.slice(0, 500));
                        const plain = errorText.trim();
                        if (plain && !/^</.test(plain)) {
                            errorMessage += `: ${plain.slice(0, 200)}`;
                        }
                    }

                    // Check if it's a session error - retry with fresh session
                    if (response.status === 401 && retryCount < MAX_RETRIES) {
                        if (handleSessionError(errorData)) {
                            retryCount++;
                            console.log(`[GeminiProxy] Session error (${errorData.code}), retrying... (attempt ${retryCount}/${MAX_RETRIES})`);

                            // Force re-initialize session
                            const sessionSuccess = await initializeSession(true);
                            if (sessionSuccess) {
                                return makeRequest();
                            } else {
                                console.error('[GeminiProxy] Failed to reinitialize session');
                            }
                        }
                    }

                    // Check for specific error codes
                    if (response.status === 500) {
                        errorMessage = errorData?.error || 'Server error while analyzing - please try again shortly';
                    } else if (response.status === 408 || response.status >= 501) {
                        // 502-504 and the Cloudflare 520-524 origin errors
                        errorMessage = 'The analysis service is busy or temporarily unavailable - please try again shortly';
                    } else if (response.status === 413) {
                        errorMessage = 'Request too large - the dump file may be too big';
                    } else if (response.status === 429) {
                        errorMessage = 'Rate limit exceeded - too many requests';
                    }

                    throw Object.assign(new Error(errorData.error || errorMessage), {
                        status: response.status,
                        code: typeof errorData.code === 'string' ? errorData.code : undefined
                    });
                }

                return response.json();
            } catch (error) {
                console.error('[GeminiProxy] Request error:', error);
                throw error;
            }
        };

        const data = await makeRequest();

        // Log response details for debugging
        if (!data || typeof data !== 'object') {
            console.error('[GeminiProxy] Invalid response data:', data);
            throw new Error('Invalid response format from API');
        }

        // Log cache status prominently
        if (data.cached) {
            console.log('[GeminiProxy] ✓ AI CACHE HIT - using cached Gemini response');
        } else {
            console.log('[GeminiProxy] AI cache MISS - fresh Gemini API call');
        }

        if (!data.text) {
            console.warn('[GeminiProxy] Response has no text field:', Object.keys(data));
        }

        // Log thinking process if available (for debugging)
        if (data.candidates?.[0]?.content?.thinking) {
            console.log('[AI] Model thinking process available');
            // Note: We don't expose thinking to the client for now
        }

        return {
            text: data.text || '',
            cached: data.cached || false
        };
    };

    return {
        models: {
            generateContent
        }
    };
};

const reportSchema = {
    type: Type.OBJECT,
    properties: {
        summary: { type: Type.STRING, description: "A brief, one-sentence summary of the crash." },
        probableCause: { type: Type.STRING, description: "A detailed but easy-to-understand explanation of the likely cause of the blue screen error, based on the provided data." },
        culprit: { type: Type.STRING, description: "The driver or system file causing the crash. Use ONLY the module named in the \"Crash location\" section if one is provided." },
        recommendations: { type: Type.ARRAY, items: { type: Type.STRING }, description: "A list of actionable steps the user should take to fix the issue." },
        driverWarnings: {
            type: Type.ARRAY,
            description: "Warnings about problematic third-party drivers found in the loaded modules list. Only include drivers that ARE present in the loaded modules. Microsoft drivers (ntoskrnl.exe, win32k.sys, etc.) should NOT be included.",
            items: {
                type: Type.OBJECT,
                properties: {
                    driverName: { type: Type.STRING, description: "Driver filename (e.g., nvlddmkm.sys)" },
                    displayName: { type: Type.STRING, description: "Human-readable name of the driver" },
                    manufacturer: { type: Type.STRING, description: "Driver manufacturer (e.g., NVIDIA, AMD, Realtek)" },
                    category: { type: Type.STRING, description: "Driver category: graphics, audio, network, storage, security, virtualization, or other" },
                    issues: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Known issues with this driver" },
                    recommendations: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Specific recommendations to fix issues with this driver" },
                    isAssociatedWithBugCheck: { type: Type.BOOLEAN, description: "True if this driver commonly causes this specific bug check code" }
                },
                required: ["driverName", "displayName", "manufacturer", "category", "issues", "recommendations", "isAssociatedWithBugCheck"]
            }
        },
        hardwareError: {
            type: Type.OBJECT,
            description: "Hardware error details for bug checks 0x124 (WHEA), 0x9C (MCE), 0x7F (TRAP), or other hardware-related crashes. Only include if this is a hardware error.",
            properties: {
                isHardwareError: { type: Type.BOOLEAN, description: "True if this crash indicates a hardware problem" },
                errorType: { type: Type.STRING, description: "Type of hardware error (e.g., 'CPU Cache Error', 'Memory Controller Error', 'PCIe Error', 'Machine Check Exception')" },
                component: { type: Type.STRING, description: "Hardware component involved (e.g., 'CPU', 'RAM', 'GPU', 'Motherboard', 'Storage')" },
                severity: { type: Type.STRING, description: "Severity level: fatal, recoverable, corrected, or deferred" },
                details: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Technical details about the hardware error decoded from bug check parameters" },
                recommendations: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Hardware-specific recommendations (e.g., 'Run MemTest86', 'Check CPU temperatures', 'Update BIOS')" }
            },
            required: ["isHardwareError", "errorType", "component", "severity", "details", "recommendations"]
        },
        parameterAnalysis: {
            type: Type.ARRAY,
            description: "Decoded bug check parameters with NTSTATUS codes, IRQL levels, and other technical details explained.",
            items: {
                type: Type.OBJECT,
                properties: {
                    parameter: { type: Type.STRING, description: "Parameter name (e.g., 'Parameter 1')" },
                    rawValue: { type: Type.STRING, description: "Raw hex value (e.g., '0xC0000005')" },
                    decoded: { type: Type.STRING, description: "Human-readable interpretation (e.g., 'STATUS_ACCESS_VIOLATION - Invalid memory access')" },
                    significance: { type: Type.STRING, description: "What this parameter tells us about the crash" }
                },
                required: ["parameter", "rawValue", "decoded", "significance"]
            }
        }
    },
    required: ["summary", "probableCause", "culprit", "recommendations"],
};

function normalizeText(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeTextArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
        : [];
}

function normalizeAnalysisReportData(value: unknown): AnalysisReportData {
    const input = (value && typeof value === 'object' && !Array.isArray(value))
        ? value as Partial<AnalysisReportData> & Record<string, any>
        : {};

    const report: AnalysisReportData = {
        ...input,
        summary: normalizeText(input.summary, 'Crash analysis completed.'),
        probableCause: normalizeText(input.probableCause, 'The probable cause could not be determined from the available data.'),
        culprit: normalizeText(input.culprit, 'Unknown'),
        recommendations: normalizeTextArray(input.recommendations)
    };

    if (report.recommendations.length === 0) {
        report.recommendations = ['Review the dump analysis details and update drivers or Windows components identified in the report.'];
    }

    if (Array.isArray(input.driverWarnings)) {
        report.driverWarnings = (input.driverWarnings as unknown[])
            .filter((warning): warning is Record<string, any> => !!warning && typeof warning === 'object')
            .map(warning => ({
                driverName: normalizeText(warning.driverName ?? warning.name, 'Unknown driver'),
                displayName: normalizeText(warning.displayName ?? warning.name ?? warning.driverName, 'Unknown driver'),
                manufacturer: normalizeText(warning.manufacturer, 'Unknown'),
                category: normalizeText(warning.category, 'other'),
                issues: normalizeTextArray(warning.issues).concat(
                    typeof warning.description === 'string' && warning.description.trim() ? [warning.description.trim()] : []
                ),
                recommendations: normalizeTextArray(warning.recommendations),
                isAssociatedWithBugCheck: Boolean(warning.isAssociatedWithBugCheck)
            }));
    }

    if (input.hardwareError && typeof input.hardwareError === 'object') {
        const hardware = input.hardwareError as Record<string, any>;
        const details = typeof hardware.details === 'string'
            ? [hardware.details]
            : normalizeTextArray(hardware.details);
        // An explicit boolean wins; infer from errorType/type only when absent (issue #247).
        const isHardwareError = typeof hardware.isHardwareError === 'boolean'
            ? hardware.isHardwareError
            : Boolean(hardware.errorType || hardware.type);
        delete report.hardwareError;
        if (isHardwareError) {
            report.hardwareError = {
                isHardwareError: true,
                errorType: normalizeText(hardware.errorType ?? hardware.type, 'Hardware error'),
                component: normalizeText(hardware.component, 'Unknown'),
                severity: normalizeText(hardware.severity, 'fatal'),
                details,
                recommendations: normalizeTextArray(hardware.recommendations)
            };
        }
    }

    if (Array.isArray(input.parameterAnalysis)) {
        report.parameterAnalysis = (input.parameterAnalysis as unknown[])
            .filter((param): param is Record<string, any> => !!param && typeof param === 'object')
            .map(param => ({
                parameter: normalizeText(param.parameter, 'Parameter'),
                rawValue: normalizeText(param.rawValue, 'Unknown'),
                decoded: normalizeText(param.decoded, 'Unknown'),
                significance: normalizeText(param.significance, 'No additional interpretation available.')
            }));
    }

    return report;
}

function looksLikeAnalysisReport(value: unknown): value is Record<string, unknown> {
    return !!value
        && typeof value === 'object'
        && !Array.isArray(value)
        && (
            'summary' in value
            || 'probableCause' in value
            || 'culprit' in value
            || 'recommendations' in value
            || 'bugCheck' in value
        );
}

function normalizeCachedAIReport(value: unknown): AnalysisReportData | null {
    if (!value) return null;

    if (typeof value === 'string') {
        try {
            return normalizeCachedAIReport(JSON.parse(value));
        } catch {
            return null;
        }
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const input = value as Record<string, unknown>;
        if (typeof input.text === 'string' && input.text.trim()) {
            try {
                return normalizeAnalysisReportData(JSON.parse(input.text));
            } catch {
                return null;
            }
        }
        if (looksLikeAnalysisReport(input)) {
            return normalizeAnalysisReportData(input);
        }
    }

    return null;
}

// --- Binary Processing Helpers ---

const readBlobAsArrayBuffer = (blob: Blob): Promise<ArrayBuffer> => {
    if (typeof blob.arrayBuffer === 'function') {
        return blob.arrayBuffer();
    }
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            if (event.target?.result instanceof ArrayBuffer) {
                resolve(event.target.result);
            } else {
                reject(new Error('Failed to read file as ArrayBuffer.'));
            }
        };
        reader.onerror = (error) => reject(error);
        reader.readAsArrayBuffer(blob);
    });
};

const readFileAsArrayBuffer = (file: File): Promise<ArrayBuffer> => readBlobAsArrayBuffer(file);

async function readSampledDumpBuffer(file: File): Promise<{ buffer: ArrayBuffer; ranges: Array<{ label: string; start: number; end: number }> }> {
    const ranges = getLargeDumpSampleRanges(file.size);
    const chunks = await Promise.all(
        ranges.map(range => readBlobAsArrayBuffer(file.slice(range.start, range.end)))
    );

    const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        combined.set(new Uint8Array(chunk), offset);
        offset += chunk.byteLength;
    }

    return { buffer: combined.buffer, ranges };
}

// Enhanced extraction functions
function getBugCheckParameterMeaning(code: number, params: bigint[]): string {
    const forced = describeForcedCrashParameters(code, params);
    if (forced) return forced;
    // Provide specific parameter meanings for common bug checks
    switch (code) {
        case 0x0000000A: // IRQL_NOT_LESS_OR_EQUAL
            return `- Arg1: Memory referenced (0x${params[0].toString(16)})
- Arg2: IRQL at time of reference (${params[1]})
- Arg3: 0=Read, 1=Write (${params[2]})
- Arg4: Address that referenced memory (0x${params[3].toString(16)})`;
        
        case 0x00000050: // PAGE_FAULT_IN_NONPAGED_AREA
            return `- Arg1: Memory referenced (0x${params[0].toString(16)})
- Arg2: 0=Read, 1=Write, 2=Execute (${params[1]})
- Arg3: Address that referenced memory (0x${params[2].toString(16)})
- Arg4: Reserved`;
        
        case 0x0000007E: // SYSTEM_THREAD_EXCEPTION_NOT_HANDLED
        case 0x0000008E: // KERNEL_MODE_EXCEPTION_NOT_HANDLED
        case 0x0000001E: // KMODE_EXCEPTION_NOT_HANDLED
            return `- Arg1: Exception code (0x${params[0].toString(16)})
- Arg2: Address where exception occurred (0x${params[1].toString(16)})
- Arg3: Exception parameter 0 (0x${params[2].toString(16)})
- Arg4: Exception parameter 1 (0x${params[3].toString(16)})`;
        
        case 0x00000124: // WHEA_UNCORRECTABLE_ERROR
            return `- Arg1: MCE bank number or 0 for other types
- Arg2: Address of WHEA_ERROR_RECORD structure
- Arg3: High 32 bits of MCi_STATUS MSR
- Arg4: Low 32 bits of MCi_STATUS MSR
**This indicates a HARDWARE ERROR detected by the CPU/chipset**`;
        
        case 0x00000139: // KERNEL_SECURITY_CHECK_FAILURE
            return `- Arg1: Type of corruption (${params[0]})
- Arg2: Address of corruption or security check
- Arg3: Expected security cookie or additional info
- Arg4: Additional context
**Security mitigation detected corruption or exploit attempt**`;
        
        case 0x000000D1: // DRIVER_IRQL_NOT_LESS_OR_EQUAL
            return `- Arg1: Memory referenced (0x${params[0].toString(16)})
- Arg2: IRQL at time of reference (${params[1]})
- Arg3: 0=Read, 1=Write, 2=Execute (${params[2]})
- Arg4: Address in driver that caused error (0x${params[3].toString(16)})`;
        
        case 0x000000C2: // BAD_POOL_CALLER
            return `- Arg1: Pool violation type (0x${params[0].toString(16)})
- Arg2: Pool header address or size
- Arg3: First part of pool header contents
- Arg4: 0
**Memory pool corruption detected - often indicates driver bugs**`;
        
        case 0x00000133: // DPC_WATCHDOG_VIOLATION
            return `- Arg1: DPC time count (if 0, single DPC exceeded timeout)
- Arg2: DPC time limit
- Arg3: Cast to nt!DPC_WATCHDOG_GLOBAL_TRIAGE_BLOCK
- Arg4: 0
**A DPC routine exceeded the permitted time limit**`;
            
        case 0x000000F5: // FLTMGR_FILE_SYSTEM
            return `- Arg1: Error Type (0x${params[0].toString(16)})
${params[0] === 0x6En ? '  - 0x6E = The context structure was referenced after being freed' : ''}
${params[0] === 0x66n ? '  - 0x66 = The filter context structure was corrupted' : ''}
${params[0] === 0x67n ? '  - 0x67 = The filter\'s context allocation definition is invalid' : ''}
${params[0] === 0x68n ? '  - 0x68 = Attempted to register context with invalid parameters' : ''}
${params[0] === 0x6An ? '  - 0x6A = Attempted to register context after shutdown' : ''}
${params[0] === 0x6Bn ? '  - 0x6B = Filter failed to free context at appropriate time' : ''}
${params[0] === 0x6Cn ? '  - 0x6C = Attempted to use FLT_CONTEXT after deletion started' : ''}
${params[0] === 0x6Dn ? '  - 0x6D = Attempted to reference FLT_FILTER after deletion started' : ''}
- Arg2: Address of the Context/Object structure (0x${params[1].toString(16)})
- Arg3: Additional context info (0x${params[2].toString(16)})
- Arg4: Reserved (0x${params[3].toString(16)})
**Filter Manager detected a fatal error - usually a filter driver bug**`;
            
        default:
            return `- Arg1: 0x${params[0].toString(16)}
- Arg2: 0x${params[1].toString(16)}
- Arg3: 0x${params[2].toString(16)}
- Arg4: 0x${params[3].toString(16)}
**Consult Microsoft documentation for parameter meanings of this specific bug check**`;
    }
}

function extractBugCheckCode(buffer: ArrayBuffer): string | null {
    // Use the improved extraction from dumpParser
    const bugCheckInfo = extractBugCheckInfo(buffer);
    if (bugCheckInfo) {
        return `${formatBugCheckHex(bugCheckInfo.code)} (${bugCheckInfo.name})`;
    }
    
    return null;
}

function extractWindowsVersion(strings: string): string | null {
    // Windows version patterns
    const patterns = [
        /Windows\s+(\d+)\s+Version\s+(\d+[A-Z]\d+)/i,
        /Microsoft Windows Version (\d+\.\d+)/i,
        /Windows\s+(\d+)\s+Build\s+(\d+)/i,
        /Version\s+(\d+[A-Z]\d+)/i,
    ];
    
    for (const pattern of patterns) {
        const match = strings.match(pattern);
        if (match) {
            return `Windows ${match[0]}`;
        }
    }
    
    // Check for specific versions
    if (strings.includes('Windows 11')) return 'Windows 11';
    if (strings.includes('Windows 10')) return 'Windows 10';
    if (strings.includes('Windows Server')) return 'Windows Server';
    
    return null;
}


function getBugCheckDescription(code: number): string {
    const descriptions: Record<number, string> = {
        0x0A: 'an attempt to access memory at an invalid IRQL level',
        0x19: 'a corrupted pool header, typically caused by a driver writing past its allocated memory',
        0x1A: 'a memory management error, often indicating RAM issues or driver corruption',
        0x1E: 'an unhandled kernel exception',
        0x24: 'a problem with the NTFS file system',
        0x3B: 'an exception in a system service routine',
        0x50: 'a page fault in an area of memory that could not be paged in',
        0x7E: 'a system thread generating an unhandled exception',
        0x7F: 'an unexpected kernel mode trap',
        0x9F: 'a driver power state failure',
        0xC2: 'a bad pool caller error, indicating a driver incorrectly using memory functions',
        0xD1: 'a driver accessing memory at an invalid IRQL',
        0xEF: 'a critical process termination',
        0x116: 'a video driver timeout, typically indicating GPU issues',
        0x133: 'a DPC watchdog violation, indicating a driver took too long',
        0x139: 'a kernel data integrity check failure',
    };
    return descriptions[code] || describeForcedCrash(code) || 'a critical system error requiring analysis';
}

function getBasicRecommendations(bugCode: number, culprit: string): string[] {
    const recs: string[] = [];

    // Generic driver recommendations
    if (culprit !== 'Unknown driver' && culprit !== 'ntoskrnl.exe') {
        recs.push(`Update or reinstall the ${culprit} driver`);
    }

    // Bug-specific recommendations
    if (bugCode === 0x19 || bugCode === 0xC2) {
        recs.push('Check for memory corruption - run Windows Memory Diagnostic');
        recs.push('Update all drivers, especially storage and filter drivers');
    } else if (bugCode === 0x1A || bugCode === 0x50) {
        recs.push('Test RAM with Windows Memory Diagnostic or MemTest86');
        recs.push('Check for disk errors with chkdsk /r');
    } else if (bugCode === 0x116) {
        recs.push('Update your graphics driver to the latest version');
        recs.push('Check GPU temperatures and ensure adequate cooling');
    } else if (bugCode === 0x9F) {
        recs.push('Update power management and chipset drivers');
        recs.push('Check power settings in Device Manager');
    }

    // Generic recommendations
    recs.push('Run System File Checker: sfc /scannow');
    recs.push('Check Windows Event Viewer for related errors');

    return recs;
}

function extractCrashTime(buffer: ArrayBuffer): string | null {
    // Look for timestamp patterns in first 4KB
    const header = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4096));
    
    // Search for Windows timestamp (100-nanosecond intervals since 1601)
    for (let i = 0; i <= header.length - 8; i += 4) {
        try {
            // Read as Windows FILETIME (little-endian)
            const view = new DataView(buffer, i, 8);
            const timestamp = view.getBigUint64(0, true);
            
            // Check if it's a reasonable timestamp (2020-2030 range)
            if (timestamp > 0x01D5C0000000000n && timestamp < 0x01E0000000000000n) {
                // Convert to datetime
                const epochOffset = 11644473600000n; // milliseconds between 1601 and 1970
                const timestampMs = timestamp / 10000n - epochOffset;
                const date = new Date(Number(timestampMs));
                
                if (date.getFullYear() >= 2020 && date.getFullYear() <= 2030) {
                    return new Intl.DateTimeFormat(undefined, {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        timeZone: 'UTC',
                        timeZoneName: 'short',
                    }).format(date);
                }
            }
        } catch {
            continue;
        }
    }
    
    return null;
}

function extractPrintableStrings(buffer: ArrayBuffer, minLength = 4): string {
    const startTime = Date.now();
    const view = new Uint8Array(buffer);
    const asciiChunks: string[] = [];

    // 1. ASCII extraction using range scanning
    let start = -1;
    for (let i = 0; i < view.length; i++) {
        if (i % 50000 === 0 && !validateProcessingTimeout(startTime)) {
            console.warn('ASCII extraction timed out');
            break;
        }
        const b = view[i];
        if (b >= 32 && b <= 126) {
            if (start === -1) start = i;
        } else {
            if (start !== -1) {
                if (i - start >= minLength) {
                    asciiChunks.push(new TextDecoder('ascii').decode(view.subarray(start, i)));
                }
                start = -1;
            }
        }
    }
    if (start !== -1 && (view.length - start) >= minLength) {
        asciiChunks.push(new TextDecoder('ascii').decode(view.subarray(start, view.length)));
    }

    // 2. UTF-16LE extraction using low/high byte checks
    const utf16Chunks: string[] = [];
    const u16Len = Math.floor(buffer.byteLength / 2);
    let u16Start = -1;
    for (let i = 0; i < u16Len; i++) {
        if (i % 25000 === 0 && !validateProcessingTimeout(startTime)) {
            console.warn('UTF-16 extraction timed out');
            break;
        }
        const low = view[i * 2];
        const high = view[i * 2 + 1];
        if (low >= 32 && low <= 126 && high === 0) {
            if (u16Start === -1) u16Start = i;
        } else {
            if (u16Start !== -1) {
                if (i - u16Start >= minLength) {
                    utf16Chunks.push(new TextDecoder('utf-16le').decode(view.subarray(u16Start * 2, i * 2)));
                }
                u16Start = -1;
            }
        }
    }
    if (u16Start !== -1 && (u16Len - u16Start) >= minLength) {
        utf16Chunks.push(new TextDecoder('utf-16le').decode(view.subarray(u16Start * 2, u16Len * 2)));
    }

    return [...asciiChunks, ...utf16Chunks].join('\n');
}

function generateHexDump(buffer: ArrayBuffer, length = PROCESSING_LIMITS.HEX_DUMP_LENGTH): string {
    const view = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, length));
    let result = '';
    for (let i = 0; i < view.length; i += 16) {
        const address = i.toString(16).padStart(8, '0');
        const slice = view.slice(i, i + 16);
        const hex = Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join(' ');
        const ascii = Array.from(slice).map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.').join('');
        result += `${address}  ${hex.padEnd(16 * 3 - 1)}  |${ascii.padEnd(16)}|\n`;
    }
    return result;
}

// Bytes past the excerpt that the redaction still reads, so a name crossing
// the excerpt's end is matched whole: one MAX_PATH of UTF-16 text.
const HEX_REDACTION_MARGIN = 520;

/**
 * generateHexDump of the first `length` bytes with personal identifiers masked
 * as bytes first (issue #359): a hex dump shows UTF-16 text as
 * "C.:.\.U.s.e.r.s." and splits ASCII across lines, so the text redaction of
 * the finished prompt cannot catch them there. Redacts a copy; `buffer` stays
 * untouched for parsing and hashing. `startsMidMemory` marks an excerpt (the
 * thread stack) that can begin inside a string, whose cut-off start is masked.
 */
function generateRedactedHexDump(
    buffer: ArrayBuffer,
    length: number,
    names: ReturnType<typeof collectPersonalNamesFromBytes>,
    startsMidMemory = false
): string {
    const window = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, length + HEX_REDACTION_MARGIN));
    const redacted = redactPersonalBytes(window, { names, maskLeadingRun: startsMidMemory });
    return generateHexDump(redacted.buffer as ArrayBuffer, length);
}


const generateInitialAnalysis = async (fileName: string, prompt: string, fileHash?: string, signal?: AbortSignal): Promise<AnalysisReportData> => {
    try {
        // Check prompt size and warn if too large
        const promptSize = new Blob([prompt]).size;
        console.log(`[AI] Prompt size for ${fileName}: ${promptSize} bytes`);
        
        if (promptSize > 100000) { // 100KB warning threshold
            console.warn(`[AI] Large prompt size (${promptSize} bytes) may cause issues`);
        }
        
        console.log('[AI] Creating Gemini proxy...');
        const ai = createGeminiProxy();
        console.log('[AI] Gemini proxy created');
        console.log('[AI] Calling generateContent...');
        const response: GenerateContentResponse = await ai.models.generateContent({
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: reportSchema,
                // Enable optimized settings for complex BSOD analysis
                temperature: 0.7,
                // No maxOutputTokens here: the server applies its own
                // AI_MAX_OUTPUT_TOKENS default, which must also cover the
                // DeepSeek reasoning trace.
            },
            fileHash, // Pass fileHash for cache key consistency
            fileHandle: getFileHandle(fileHash), // Proves this session uploaded it
            signal
            // Note: Grounding with Google Search cannot be used with JSON response format
            // To use grounding, we would need to remove responseMimeType and responseSchema
        });
        console.log('[AI] generateContent response received');

        let jsonText = response.text;
        
        // Log response size and preview
        console.log(`[AI] Response size: ${jsonText?.length || 0} chars`);
        if (jsonText && jsonText.length > 100) {
            console.log('[AI] Response preview:', jsonText.substring(0, 100) + '...');
            console.log('[AI] Response end:', '...' + jsonText.substring(jsonText.length - 100));
        }
        
        // Check if response is empty
        if (!jsonText || jsonText.trim() === '') {
            throw new Error('Empty response from API');
        }
        
        // Clean up the response if it's wrapped in markdown code blocks
        if (jsonText.startsWith('```json')) {
            jsonText = jsonText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
        } else if (jsonText.startsWith('```')) {
            jsonText = jsonText.replace(/^```\s*/, '').replace(/\s*```$/, '');
        }
        
        // Trim any whitespace
        jsonText = jsonText.trim();
        
        // Try to fix common JSON issues
        try {
            // First attempt: direct parse
            const parsedJson = JSON.parse(jsonText);
            return normalizeAnalysisReportData(parsedJson);
        } catch (parseError) {
            console.error('[AI] JSON parse error:', parseError);
            console.error('[AI] Raw response preview:', jsonText.substring(0, 500) + '...');
            
            // Attempt to fix truncated JSON
            if (parseError instanceof SyntaxError && parseError.message.includes('unterminated string')) {
                console.warn('[AI] Attempting to fix unterminated string in JSON');
                
                // Try different fixes for unterminated strings
                const fixes = [
                    () => jsonText + '"',  // Add missing quote
                    () => jsonText + '"}',  // Close string and object
                    () => jsonText + '"]}', // Close string and array
                    () => jsonText + '"}]}', // Close all structures
                    () => {
                        // Find last complete property and truncate there
                        const lastComma = jsonText.lastIndexOf('",');
                        if (lastComma > 0) {
                            return jsonText.substring(0, lastComma + 1) + ']}';
                        }
                        return jsonText;
                    }
                ];
                
                for (const fix of fixes) {
                    try {
                        const fixedJson = fix();
                        const parsedJson = JSON.parse(fixedJson);
                        console.warn('[AI] Successfully fixed JSON with strategy:', fixes.indexOf(fix));
                        return normalizeAnalysisReportData(parsedJson);
                    } catch {
                        // Try next fix
                    }
                }
            }
            
            // If all else fails, return a fallback response
            console.error('[AI] Unable to parse response, using fallback');
            return {
                summary: `Analysis failed due to malformed response for ${fileName}`,
                probableCause: 'The AI response was malformed. This might be due to the large size of the dump file or API limitations.',
                culprit: 'Unknown - analysis incomplete',
                recommendations: [
                    'Try analyzing a smaller dump file',
                    'Check that the Gemini API key is properly configured',
                    'Ensure the dump file is not corrupted'
                ]
            };
        }
    } catch (error) {
        console.error(`Error analyzing ${fileName}:`, error);
        if (signal?.aborted) throw createCancelledError();

        // Keep the real cause: an unmapped status is not evidence of a missing
        // API key (issue #230). The status/code travel on the wrapped error.
        const { status, code } = (error ?? {}) as { status?: number; code?: string };
        throw Object.assign(
            new Error(`Failed to generate analysis for ${fileName}. ${error instanceof Error ? error.message : 'Unknown error'}`),
            { status, code }
        );
    }
};


function formatSampleRanges(ranges: Array<{ label: string; start: number; end: number }>): string {
    return ranges
        .map(range => `${range.label}: bytes ${range.start}-${Math.max(range.start, range.end - 1)} (${range.end - range.start} bytes)`)
        .join('; ');
}

async function generateLargeDumpAiFailoverReport(
    dumpFile: DumpFile,
    fileLabel: string,
    windbgFailure: unknown,
    signal?: AbortSignal
): Promise<AnalysisReportData> {
    console.log('[Analyzer] Using lightweight AI failover for large dump:', fileLabel);
    const { buffer: sampledBuffer, ranges } = await readSampledDumpBuffer(dumpFile.file);
    const rawExtractedStrings = extractPrintableStrings(sampledBuffer);
    const extractedStrings = sanitizeExtractedContent(rawExtractedStrings);
    const bugCheckCode = extractBugCheckCode(sampledBuffer);
    const windowsVersion = extractWindowsVersion(rawExtractedStrings);
    // Names the dump reveals (profile folders, USERNAME=, ...) are masked in
    // the hex excerpt and the whole prompt, not only where they first appear.
    // Read from the bytes: the extracted strings drop non-ASCII text (#365).
    const personalNames = collectPersonalNamesFromBytes(new Uint8Array(sampledBuffer));
    const sampleHexDump = generateRedactedHexDump(sampledBuffer, PROCESSING_LIMITS.HEX_DUMP_LENGTH, personalNames);
    const samplingSummary = formatSampleRanges(ranges);

    let evidence = `**File:** ${fileLabel} (${dumpFile.dumpType}, ${dumpFile.file.size} bytes)

**Fallback Mode:** WinDBG server was unavailable, so this is a lightweight AI failover analysis using sampled dump bytes only.
**WinDBG Failure:** ${describeWinDbgFailureForPrompt(windbgFailure).slice(0, 500)}
**Sampling:** ${samplingSummary || 'No bytes sampled'}
**Sample Size:** ${sampledBuffer.byteLength} bytes

${windowsVersion ? `**Windows Version Evidence:** ${windowsVersion}\n` : ''}
${bugCheckCode ? `**Bug Check:** ${bugCheckCode}\n` : ''}

**Binary Sample Hex Dump (${Math.min(sampledBuffer.byteLength, PROCESSING_LIMITS.HEX_DUMP_LENGTH)} bytes):**
\`\`\`hex
${sampleHexDump}
\`\`\`

**Extracted Strings From Sample (${extractedStrings.length} of ${rawExtractedStrings.length} chars):**
\`\`\`
${extractedStrings}
\`\`\``;

    if (bugCheckCode) {
        evidence += `

### ⚠️ BUG CHECK DETECTED: ${bugCheckCode}
The bug check code above was found in the sampled bytes. Full parameter decoding was skipped to avoid main-thread parsing of a large dump while WinDBG was unavailable.`;
    } else {
        evidence += `

### ⚠️ NO BUG CHECK CODE FOUND
WinDBG was unavailable and the sampled bytes did not contain a validated bug check code. Analyze only the sampled evidence and clearly state uncertainty.`;
    }

    evidence += `

### FAILOVER LIMITATION
This is not a full WinDBG analysis. Do not invent missing stack frames, modules, parameters, or bug check codes. Prefer cautious recommendations that fit the sampled evidence.`;

    // Dump strings go to the AI provider and are stored with the report:
    // redact profile folder names and email addresses first (issue #345).
    const prompt = wrapWithEvidence(LOCAL_DUMP_PREFIX, redactPersonalIdentifiers(evidence, { names: personalNames }));
    const report = await generateInitialAnalysis(fileLabel, prompt, dumpFile.fileHash, signal);

    if (!report.summary.toLowerCase().includes('failover') && !report.summary.toLowerCase().includes('limited')) {
        report.summary = `Limited WinDBG failover analysis: ${report.summary}`;
    }

    return report;
}

// Add global error handler for debugging
if (typeof window !== 'undefined') {
    window.addEventListener('error', (event) => {
        console.error('[Global Error]', event.error);
        console.error('[Global Error Stack]', event.error?.stack);
    });
}

// Extract the signal-bearing slice of a WinDBG analysis — see server.js counterpart.
function extractCrashSignal(raw: string, maxBytes = 16384): string {
    if (!raw || typeof raw !== 'string') return raw;

    const startMarker = raw.indexOf('Bugcheck Analysis');
    const headerStart = startMarker > -1 ? raw.lastIndexOf('\n***', startMarker) : -1;
    const quitIdx = raw.lastIndexOf('\nquit:');

    let slice: string;
    if (headerStart > -1 && quitIdx > headerStart) slice = raw.slice(headerStart, quitIdx);
    else if (headerStart > -1) slice = raw.slice(headerStart);
    else slice = raw.slice(0, maxBytes);

    slice = slice
        .split('\n')
        .filter(line => !/^NatVis script (loaded|unloaded)/.test(line))
        .filter(line => !/^\s*Deferred\s+/.test(line))
        .filter(line => !/^\*{10,}\s*(Preparing|Waiting|Path validation|Symbol Loading Error Summary)/.test(line))
        .join('\n');

    if (slice.length > maxBytes) {
        const head = Math.floor(maxBytes * 0.75);
        const tail = maxBytes - head - 40;
        slice = `${slice.slice(0, head)}\n\n[... ${slice.length - head - tail} bytes elided ...]\n\n${slice.slice(-tail)}`;
    }
    return slice;
}

// Fields parsed straight from the WinDBG output and its structured signal;
// they take precedence over the AI's answer for structured data.
function getWinDbgReportFields(windbgAnalysis: string, structured?: Record<string, unknown> | null) {
    const parsedFields = parseWinDbgOutput(windbgAnalysis) as Partial<AnalysisReportData>;
    const structuredFields = mapStructuredSignalToReport(structured || undefined, {
        explainBugCheckParameter: (code: number, parameter: number, value: bigint) =>
            getParameterExplanation(code, parameter as 1 | 2 | 3 | 4, value)
    }) as Partial<AnalysisReportData>;
    return { parsedFields, structuredFields };
}

// The post-AI merge every WinDBG-backed report gets, whether the AI answer is
// fresh or comes from the analysis cache (issue #237).
function mergeAiReportWithWinDbg(
    aiReport: AnalysisReportData,
    windbgAnalysis: string,
    structured?: Record<string, unknown> | null
): AnalysisReportData {
    const { parsedFields, structuredFields } = getWinDbgReportFields(windbgAnalysis, structured);
    return normalizeAnalysisReportData(mergeReportWithWinDbgFields(aiReport, structuredFields, parsedFields));
}

/**
 * Generate an AI report from WinDBG server analysis output.
 * This function takes the raw WinDBG analysis text and asks the AI to
 * interpret it in a user-friendly format following our standard report schema.
 */
async function generateReportFromWinDBG(
    fileName: string,
    dumpType: 'minidump' | 'kernel',
    fileSize: number,
    windbgAnalysis: string,
    fileHash?: string,
    options: {
        analysisSignalText?: string;
        structured?: Record<string, unknown>;
        signal?: AbortSignal;
    } = {}
): Promise<AnalysisReportData> {
    console.log('[Analyzer] Generating AI report from WinDBG analysis...');
    console.log('[Analyzer] WinDBG analysis length:', windbgAnalysis.length, 'chars');

    // Parse structured fields directly from WinDBG output (more reliable than AI extraction)
    const { parsedFields, structuredFields } = getWinDbgReportFields(windbgAnalysis, options.structured);
    console.log('[Analyzer] Parsed WinDBG fields:', {
        failureBucketId: parsedFields.failureBucketId ? 'present' : 'missing',
        symbolName: parsedFields.symbolName ? 'present' : 'missing',
        callStackFrames: parsedFields.callStack?.length || 0,
        processName: parsedFields.systemInfo?.processName || structuredFields.systemInfo?.processName || 'missing',
        kernelBuild: parsedFields.systemInfo?.kernelBuild || structuredFields.systemInfo?.kernelBuild || 'missing'
    });

    const structuredSignal = typeof options.analysisSignalText === 'string'
        ? options.analysisSignalText.trim()
        : '';
    const analysisForPrompt = structuredSignal || extractCrashSignal(windbgAnalysis);
    const promptSource = structuredSignal ? 'structured JSON' : 'raw excerpt';
    console.log(`[Analyzer] WinDBG AI evidence (${promptSource}): ${windbgAnalysis.length} -> ${analysisForPrompt.length} chars`);

    // Invariant WinDBG instructions live in WINDBG_PREFIX (shared, cache-stable);
    // only the per-dump file info + relevant WinDBG evidence goes in the tail.
    const evidence = `**File Information:**
- Filename: ${fileName}
- Dump Type: ${dumpType}
- File Size: ${fileSize} bytes

${WINDBG_OUTPUT_MARKER}
${structuredSignal ? WINDBG_STRUCTURED_NOTE : WINDBG_RAW_NOTE}
\`\`\`${structuredSignal ? 'json' : ''}
${analysisForPrompt}
\`\`\``;
    const prompt = wrapWithEvidence(WINDBG_PREFIX, evidence);

    const ai = createGeminiProxy();

    try {
        const response = await ai.models.generateContent({
            contents: prompt,
            config: {
                responseMimeType: 'application/json',
                responseSchema: reportSchema,
                temperature: 0.5
                // No maxOutputTokens: let the server's AI_MAX_OUTPUT_TOKENS
                // default govern the output budget.
            },
            fileHash, // Pass fileHash for cache key consistency
            fileHandle: getFileHandle(fileHash), // Proves this session uploaded it
            signal: options.signal
        });

        const responseText = response.text;
        console.log('[Analyzer] WinDBG AI response length:', responseText.length);

        // Parse the JSON response
        try {
            const aiReport = normalizeAnalysisReportData(JSON.parse(responseText));
            console.log('[Analyzer] Successfully parsed WinDBG-based report');
            // Merge AI report with directly parsed fields (parsed fields take precedence for structured data)
            const mergedReport = mergeAiReportWithWinDbg(aiReport, windbgAnalysis, options.structured);
            console.log('[Analyzer] Merged report has:', {
                failureBucketId: mergedReport.failureBucketId || 'missing',
                symbolName: mergedReport.symbolName || 'missing',
                kernelBuild: mergedReport.systemInfo?.kernelBuild || 'missing',
                rawWinDbgOutput: mergedReport.rawWinDbgOutput ? `${mergedReport.rawWinDbgOutput.length} chars` : 'missing',
                callStack: mergedReport.callStack?.length || 0
            });
            return mergedReport;
        } catch (parseError) {
            console.error('[Analyzer] Failed to parse WinDBG AI response:', parseError);

            // Try to extract JSON from the response
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    const aiReport = normalizeAnalysisReportData(JSON.parse(jsonMatch[0]));
                    console.log('[Analyzer] Extracted JSON from WinDBG response');
                    return mergeAiReportWithWinDbg(aiReport, windbgAnalysis, options.structured);
                } catch {
                    // Continue to fallback
                }
            }

            // Return a basic report from WinDBG output with parsed fields
            return mergeReportWithWinDbgFields({
                summary: `Windows crash analyzed via WinDBG for ${fileName}`,
                probableCause: 'Analysis completed by WinDBG server. See raw output for details.',
                culprit: extractCulpritFromWinDBG(windbgAnalysis),
                recommendations: [
                    'Review the full WinDBG analysis output',
                    'Update the identified driver if applicable',
                    'Check for Windows updates',
                    'Run system file checker (sfc /scannow)'
                ]
            }, structuredFields, parsedFields) as AnalysisReportData;
        }
    } catch (error) {
        // A failed AI request (429, 5xx, network, timeout, expired session)
        // propagates so the file ends in ERROR with a Retry button instead of
        // a "Completed" placeholder (issue #232). Only a delivered answer that
        // cannot be parsed (above) falls back to the WinDBG-only report.
        console.error('[Analyzer] WinDBG AI analysis error:', error);
        if (options.signal?.aborted) throw createCancelledError();
        throw error;
    }
}

/**
 * Extract the culprit module name from WinDBG output
 */
function extractCulpritFromWinDBG(windbgOutput: string): string {
    // Try to find MODULE_NAME from WinDBG output
    const moduleMatch = windbgOutput.match(/MODULE_NAME:\s*(\S+)/i);
    if (moduleMatch) {
        return moduleMatch[1];
    }

    // Try IMAGE_NAME
    const imageMatch = windbgOutput.match(/IMAGE_NAME:\s*(\S+)/i);
    if (imageMatch) {
        return imageMatch[1];
    }

    // Try FAULTING_MODULE
    const faultingMatch = windbgOutput.match(/FAULTING_MODULE:\s*\S+\s+(\S+)/i);
    if (faultingMatch) {
        return faultingMatch[1];
    }

    // Try to find from STACK_TEXT - first non-nt module
    const stackMatch = windbgOutput.match(/STACK_TEXT:[\s\S]*?(\w+![^\s]+)/);
    if (stackMatch) {
        const module = stackMatch[1].split('!')[0];
        if (module && !module.startsWith('nt') && module !== 'UNKNOWN') {
            return module;
        }
    }

    return 'Unknown';
}

// How long a WinDBG result kept after an AI-only failure may be reused by
// Retry (issue #331): below the server's one-hour ownership window, within
// which the file handle still proves this session uploaded the dump and the
// server rebuilds the prompt from the owned job's evidence.
export const WINDBG_RESULT_REUSE_MS = 50 * 60 * 1000;

function reusableWinDbgResult(dumpFile: DumpFile): RetainedWinDbgResult | null {
    const kept = dumpFile.windbgResult;
    if (!kept || typeof kept.analysisText !== 'string' || !kept.analysisText.trim()) return null;
    if (!(Date.now() - kept.completedAt < WINDBG_RESULT_REUSE_MS)) return null;
    if (kept.fileHash && !getFileHandle(kept.fileHash)) return null;
    // The handle is signed for the session that uploaded the dump; after a new
    // session (SSO re-verification, Turnstile) the server would no longer treat
    // the job as owned, so upload again instead (#341).
    if (kept.sessionGeneration !== getSessionGeneration()) return null;
    return kept;
}

export const analyzeDumpFiles = async (
    files: DumpFile[],
    onProgress?: (stage: 'uploading' | 'queued' | 'processing' | 'downloading' | 'analyzing' | 'complete', message: string) => void,
    onFileComplete?: (result: FileAnalysisResult) => void,
    onUploadProgress?: (percent: number) => void,
    options?: { signal?: AbortSignal }
) => {
    const MAX_CLIENT_ANALYSIS_CONCURRENCY = 2;
    const FULL_LOCAL_ANALYSIS_LIMIT = FILE_SIZE_THRESHOLDS.MINIDUMP;
    const throwIfAborted = () => {
        if (options?.signal?.aborted) {
            throw new Error('Analysis cancelled');
        }
    };

    // Process files through a small queue so the browser does not exceed backend
    // WinDBG upload concurrency and force avoidable local-analysis fallbacks.
    // Each file's result is streamed to onFileComplete as it finishes

    const analyzeFile = async (dumpFile: DumpFile): Promise<FileAnalysisResult> => {
        const fileLabel = dumpFile.displayName || dumpFile.file.name;
        const result = await (async () => {
        try {
            throwIfAborted();
            console.log('[Analyzer] Starting analysis for:', fileLabel);
            if (dumpFile.knownCached && dumpFile.fileHash) {
                console.log(`[Analyzer] Cache hint found for ${fileLabel}; attempting hash-only cache retrieval`);
            }

            let cachedFileBuffer: ArrayBuffer | null = null;
            const getFileBuffer = async (): Promise<ArrayBuffer> => {
                throwIfAborted();
                if (!cachedFileBuffer) {
                    cachedFileBuffer = await readFileAsArrayBuffer(dumpFile.file);
                    console.log('[Analyzer] File buffer loaded, size:', cachedFileBuffer.byteLength);
                }
                return cachedFileBuffer;
            };

            // WinDBG-backed reports take the bug check from the dump's own header
            // (accurate code and parameter meanings) on every path: fresh run,
            // cached WinDBG analysis and hash fast path (issue #237).
            const applyDumpBugCheck = async (report: AnalysisReportData): Promise<AnalysisReportData> => {
                try {
                    if (dumpFile.file.size <= 5 * 1024 * 1024) {
                        const fileBuffer = await getFileBuffer();
                        const bugCheckInfo = extractBugCheckInfo(fileBuffer);
                        if (bugCheckInfo) {
                            const bugCode = bugCheckInfo.code;
                            const bugName = bugCheckInfo.name;
                            const params = [
                                bugCheckInfo.parameter1,
                                bugCheckInfo.parameter2,
                                bugCheckInfo.parameter3,
                                bugCheckInfo.parameter4
                            ];

                            report.bugCheck = {
                                code: formatBugCheckHex(bugCode),
                                name: bugName,
                                parameters: params.map((p, i) => ({
                                    value: `0x${p.toString(16).toUpperCase()}`,
                                    meaning: getParameterExplanation(bugCode, (i + 1) as 1 | 2 | 3 | 4, p)
                                }))
                            };
                        }
                    } else {
                        console.log('[Analyzer] Skipping client-side bug check extraction for large WinDBG-analyzed dump');
                    }
                } catch (e) {
                    console.error('[Analyzer] Failed to extract bug check info from binary buffer:', e);
                }
                return report;
            };

            // The AI step after a successful WinDBG run. An AI failure (not a
            // cancellation) ends in ERROR carrying the WinDBG result, so Retry
            // can run only this step again (issue #331).
            const reportFromWinDbg = async (windbg: RetainedWinDbgResult): Promise<FileAnalysisResult> => {
                onProgress?.('analyzing', 'AI is interpreting the crash analysis...');
                let windbgReport: AnalysisReportData;
                try {
                    windbgReport = await generateReportFromWinDBG(
                        fileLabel,
                        dumpFile.dumpType,
                        dumpFile.file.size,
                        windbg.analysisText,
                        windbg.fileHash,
                        {
                            analysisSignalText: windbg.analysisSignalText,
                            structured: windbg.structured,
                            signal: options?.signal
                        }
                    );
                } catch (aiError) {
                    if (options?.signal?.aborted) throw aiError;
                    console.error(`Analysis failed for ${fileLabel}:`, aiError);
                    return {
                        id: dumpFile.id,
                        error: `Failed to read or analyze file. ${(aiError as Error).message}`,
                        status: FileStatus.ERROR,
                        windbgResult: windbg
                    };
                }

                // Populate bugCheck from binary buffer (guarantees accurate code and parameters meanings)
                await applyDumpBugCheck(windbgReport);

                return {
                    id: dumpFile.id,
                    report: windbgReport,
                    status: FileStatus.ANALYZED,
                    cached: windbg.cached || false,
                    analysisMethod: 'windbg' as const
                };
            };

            // Retry after an AI-only failure: reuse the kept WinDBG result
            // instead of uploading the dump and queueing a second job (#331).
            const kept = reusableWinDbgResult(dumpFile);
            if (kept) {
                console.log(`[Analyzer] Reusing the WinDBG result for ${fileLabel}; running only the AI step`);
                return await reportFromWinDbg(kept);
            }

            if (dumpFile.knownCached && dumpFile.fileHash) {
                let cached: Awaited<ReturnType<typeof getCachedAnalysisByHash>> = null;
                try {
                    onProgress?.('downloading', 'Loading cached analysis...');
                    cached = await getCachedAnalysisByHash(dumpFile.fileHash);
                } catch (cacheError) {
                    throwIfAborted();
                    console.warn('[Analyzer] Cached analysis retrieval failed; falling back to WinDBG upload:', cacheError);
                }
                throwIfAborted();

                // Only the cache read falls back to the upload; an AI failure on
                // a cached WinDBG analysis ends in ERROR (issue #232).
                if (cached?.cached) {
                    const cachedWinDbg = typeof cached.windbgAnalysis === 'string'
                        ? cached.windbgAnalysis.trim()
                        : '';
                    const cachedReport = normalizeCachedAIReport(cached.aiReport);
                    if (cachedReport) {
                        console.log(`[Analyzer] Cache HIT - using cached AI report for ${fileLabel}`);
                        // The cache stores the raw AI answer: give it the same
                        // WinDBG merge and bug check a fresh run gets (#237).
                        const report = cachedWinDbg
                            ? await applyDumpBugCheck(mergeAiReportWithWinDbg(cachedReport, cachedWinDbg, cached.structured))
                            : cachedReport;
                        return {
                            id: dumpFile.id,
                            report,
                            status: FileStatus.ANALYZED,
                            cached: true,
                            analysisMethod: cached.windbgAnalysis ? 'windbg' as const : 'local' as const
                        };
                    }

                    if (cachedWinDbg) {
                        console.log(`[Analyzer] Cache HIT - generating report from cached WinDBG analysis for ${fileLabel}`);
                        onProgress?.('analyzing', 'AI is interpreting cached crash analysis...');
                        const report = await generateReportFromWinDBG(
                            fileLabel,
                            dumpFile.dumpType,
                            dumpFile.file.size,
                            cachedWinDbg,
                            dumpFile.fileHash,
                            {
                                analysisSignalText: cached.analysisSignalText || undefined,
                                structured: cached.structured || undefined,
                                signal: options?.signal
                            }
                        );
                        await applyDumpBugCheck(report);
                        return {
                            id: dumpFile.id,
                            report,
                            status: FileStatus.ANALYZED,
                            cached: true,
                            analysisMethod: 'windbg' as const
                        };
                    }

                    console.warn(`[Analyzer] Cache entry for ${fileLabel} did not contain a usable AI report or WinDBG analysis`);
                } else {
                    console.log(`[Analyzer] Cache MISS for ${fileLabel}; falling back to WinDBG upload`);
                }
            }

            // Try WinDBG server analysis first
            let windbgResult: WinDBGAnalysisResult | null = null;
            let useLightweightAiFailover = false;
            let windbgFailure: unknown = null;
            let uploadSessionGeneration: number | undefined;
            try {
                // Deep WinDBG kernel-dump analysis is a WindowsForum Premium Supporters
                // feature. Non-premium tiers skip the upload (the backend would 403
                // anyway) and fall through to the local parser + Gemini path below,
                // which remains fully functional — just less detailed. Only enforced
                // when the SSO/premium feature is enabled; otherwise WinDBG is tried as
                // before for everyone.
                if (SSO_ENABLED && !isPremiumTier()) {
                    throw Object.assign(new Error('Deep WinDBG analysis requires WindowsForum Premium'), { code: 'PREMIUM_REQUIRED' });
                }
                console.log('[Analyzer] Attempting WinDBG server analysis...');
                uploadSessionGeneration = getSessionGeneration();
                windbgResult = await analyzeWithWinDBG(dumpFile.file, (stage, message) => {
                    console.log(`[WinDBG] ${stage}: ${message}`);
                    // Forward WinDBG progress to the UI
                    if (onProgress) {
                        onProgress(stage, message);
                    }
                }, onUploadProgress, options?.signal);

                if (!windbgResult.success) {
                    console.log('[Analyzer] WinDBG analysis failed:', windbgResult.error);
                    if (/turnstile verification required/i.test(windbgResult.error || '')) {
                        throw new Error(windbgResult.error);
                    }
                    windbgFailure = Object.assign(new Error(windbgResult.error || 'WinDBG analysis failed'), { code: windbgResult.errorCode });
                    if (shouldUseLightweightAiFailover(dumpFile.file.size, FULL_LOCAL_ANALYSIS_LIMIT)) {
                        useLightweightAiFailover = true;
                        onProgress?.('analyzing', 'WinDBG server unavailable \u2014 using lightweight AI fallback for this large dump');
                    } else {
                        console.log('[Analyzer] Falling back to local analysis...');
                        onProgress?.('analyzing', 'WinDBG server unavailable \u2014 using local analysis (results may be less detailed)');
                    }
                }
            } catch (windbgError) {
                console.error('[Analyzer] WinDBG server error:', windbgError);
                if (isTurnstileRequiredError(windbgError)) {
                    throw windbgError;
                }
                windbgFailure = windbgError;
                if (shouldUseLightweightAiFailover(dumpFile.file.size, FULL_LOCAL_ANALYSIS_LIMIT)) {
                    useLightweightAiFailover = true;
                    onProgress?.('analyzing', 'WinDBG server unavailable \u2014 using lightweight AI fallback for this large dump');
                } else {
                    console.log('[Analyzer] Falling back to local analysis...');
                    onProgress?.('analyzing', 'WinDBG server unavailable \u2014 using local analysis (results may be less detailed)');
                }
            }

            // A cancelled run must not continue into the local-parse/AI fallback:
            // the WinDBG leg aborts promptly now (issue #121), and this keeps the
            // rest of the pipeline from doing zombie work too. It sits after the
            // try/catch so the cancellation is not mistaken for a WinDBG failure.
            throwIfAborted();

            // The AI step runs outside the WinDBG try/catch: an AI failure after a
            // successful WinDBG run is not a WinDBG failure, so it must end in ERROR
            // rather than fall back to local analysis (issue #232).
            if (windbgResult?.success) {
                console.log(`[Analyzer] WinDBG analysis successful (${windbgResult.processingTime}s)`);
                return await reportFromWinDbg({
                    analysisText: windbgResult.analysisText,
                    analysisSignalText: windbgResult.analysisSignalText,
                    structured: windbgResult.structured,
                    fileHash: windbgResult.fileHash,
                    cached: windbgResult.cached,
                    completedAt: Date.now(),
                    sessionGeneration: uploadSessionGeneration
                });
            }

            if (useLightweightAiFailover) {
                const report = await generateLargeDumpAiFailoverReport(dumpFile, fileLabel, windbgFailure, options?.signal);
                return { id: dumpFile.id, report, status: FileStatus.ANALYZED, analysisMethod: 'local' as const };
            }

            // Fallback: Use local analysis if WinDBG failed
            // AdvancedDumpParser removed - using accurate kernelDumpModuleParser instead
            const fileBuffer = await getFileBuffer();

            console.log('[Analyzer] Extracting printable strings...');
            const rawExtractedStrings = extractPrintableStrings(fileBuffer);
            console.log('[Analyzer] Extracted strings length:', rawExtractedStrings.length);
            
            // Capped at PROCESSING_LIMITS.MAX_STRINGS_LENGTH by the sanitizer.
            const extractedStrings = sanitizeExtractedContent(rawExtractedStrings);
            // Names the dump reveals (profile folders, USERNAME=, ...) are
            // masked in the hex excerpts and the whole prompt (issues #359,
            // #360), read from the bytes: the extracted strings drop
            // non-ASCII text (issue #365).
            const personalNames = collectPersonalNamesFromBytes(new Uint8Array(fileBuffer));

            // Get structured dump information
            console.log('[Analyzer] Getting structured dump info...');
            const structuredInfo = getStructuredDumpInfo(fileBuffer, rawExtractedStrings);
            console.log('[Analyzer] Structured info obtained');

            // Use accurate kernel dump parser for PAGEDU64 files
            let accurateModuleInfo: KernelDumpResult | null = null;
            try {
                console.log('[Analyzer] Attempting accurate kernel dump parsing...');
                accurateModuleInfo = parseKernelDump(fileBuffer);
                if (accurateModuleInfo) {
                    console.log('[Analyzer] Accurate kernel dump parsed successfully');
                    console.log('[Analyzer] Bug check:', accurateModuleInfo.bugCheck.name);
                    console.log('[Analyzer] Culprit module:', accurateModuleInfo.culpritModule);
                    console.log('[Analyzer] Module count:', accurateModuleInfo.modules.length);
                }
            } catch (kernelParseError) {
                console.log('[Analyzer] Kernel dump parsing not applicable:', kernelParseError);
            }

            // Extract additional information
            const bugCheckCode = structuredInfo.bugCheckInfo ?
                `${formatBugCheckHex(structuredInfo.bugCheckInfo.code)} (${structuredInfo.bugCheckInfo.name})` :
                extractBugCheckCode(fileBuffer);
            const windowsVersion = extractWindowsVersion(rawExtractedStrings);
            const crashTime = extractCrashTime(fileBuffer);
            
            // Analyze crash context
            const crashContext = structuredInfo.bugCheckInfo ? 
                analyzeCrashContext(
                    structuredInfo.bugCheckInfo.code,
                    [structuredInfo.bugCheckInfo.parameter1, structuredInfo.bugCheckInfo.parameter2],
                    rawExtractedStrings
                ) : null;

            // Analyze memory patterns for additional corruption detection
            let memoryPatternAnalysis;
            try {
                // Skip memory pattern scanning for large files (above 5MB) on client
                // to avoid blocking the UI thread with billions of loop iterations
                if (fileBuffer.byteLength > 5 * 1024 * 1024) {
                    memoryPatternAnalysis = { summary: 'Skipped for large dump file.' };
                } else {
                    memoryPatternAnalysis = analyzeMemoryPatterns(fileBuffer);
                    console.log('[Analyzer] Memory pattern analysis complete:', memoryPatternAnalysis.summary);
                }
            } catch (error) {
                console.error('[Analyzer] Memory pattern analysis failed:', error);
                memoryPatternAnalysis = null;
            }
            
            // Extract driver versions and check for outdated drivers
            let outdatedDrivers: Array<{ name: string; version: string; status: string }> = [];
            try {
                const moduleInfo = structuredInfo.moduleList.map(m => ({
                    name: m.name,
                    baseAddress: BigInt(m.base || 0n),
                    sizeOfImage: m.size || 0
                }));
                const driverVersions = extractDriverVersions(fileBuffer, moduleInfo);
                outdatedDrivers = identifyOutdatedDrivers(driverVersions);
                if (outdatedDrivers.length > 0) {
                    console.log('[Analyzer] Found outdated drivers:', outdatedDrivers);
                }
            } catch (error) {
                console.error('[Analyzer] Driver version extraction failed:', error);
            }

            // Extract additional memory regions for analysis
            let memoryRegions: string[] = [];
            let stackData = '';
            let threadInfo = '';
            
            try {
                // Get more stack data if available (for MDMP minidumps only).
                // extractDumpHeader() reports the MINIDUMP signature — not the
                // raw "MDMP" file magic — for this format.
                if (structuredInfo.dumpHeader?.signature === 'MINIDUMP') {
                    const parser = new MinidumpParser(fileBuffer);
                    const threads = parser.getThreads();
                    
                    if (threads.length > 0) {
                        // Get stack data from first thread
                        const thread = threads[0];
                        const stackMemory = parser.getThreadStack(thread.threadId);
                        
                        if (stackMemory && stackMemory.byteLength > 0) {
                            const stackHex = generateRedactedHexDump(stackMemory, Math.min(stackMemory.byteLength, PROCESSING_LIMITS.MAX_STACK_MEMORY_SIZE), personalNames, true);
                            stackData = `\n\n**Thread Stack Memory (Thread ID: ${thread.threadId}):**\n\`\`\`hex\n${stackHex}\n\`\`\``;
                        }
                        
                        // Build thread information
                        const threadDetails = [];
                        for (let i = 0; i < Math.min(threads.length, 10); i++) {
                            const t = threads[i];
                            threadDetails.push(`Thread ${i} (ID: ${t.threadId}): RIP=0x${t.instructionPointer.toString(16)}, RSP=0x${t.stackPointer.toString(16)}, RBP=0x${t.framePointer.toString(16)}, Priority=${t.priority}`);
                        }
                        threadInfo = threadDetails.join('\n');
                    }
                    
                    // Extract memory regions around important addresses
                    if (structuredInfo.exceptionInfo) {
                        const exceptionAddr = structuredInfo.exceptionInfo.address;
                        memoryRegions.push(`Exception Address Region (0x${exceptionAddr.toString(16)}):`);
                    }
                }
            } catch (error) {
                console.error('[Analyzer] Failed to extract additional memory data:', error);
            }
            
            // Estimate tokens (rough approximation: 1 token ≈ 4 characters)
            const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
            
            // Reduced token target - with accurate kernel dump parsing, we need less data
            const TARGET_TOKENS = 25000;
            const MAX_TOKENS = 50000;
            
            // Build prompt sections with token tracking
            let currentTokens = 0;
            const promptSections: { [key: string]: string } = {};
            
            // Essential sections (always include) - simplified with accurate parsing
            // Dump-specific evidence only — the invariant analysis instructions
            // live in LOCAL_DUMP_PREFIX (shared, cache-stable) and are prepended
            // below so Gemini implicit caching can reuse the prefix across dumps.
	            const essentialPrefix = `**File:** ${fileLabel} (${dumpFile.dumpType}, ${dumpFile.file.size} bytes)`;
            
            promptSections.essential = essentialPrefix;
            currentTokens += estimateTokens(essentialPrefix);
            
            // Add sections in priority order, checking token count
            const addSection = (name: string, content: string, _priority: number) => {
                const tokens = estimateTokens(content);
                if (currentTokens + tokens < TARGET_TOKENS) {
                    promptSections[name] = content;
                    currentTokens += tokens;
                    console.log(`[Analyzer] Added ${name} section: ${tokens} tokens (total: ${currentTokens})`);
                    return true;
                } else {
                    console.log(`[Analyzer] Skipped ${name} section: would exceed token limit`);
                    return false;
                }
            };
            
            // Priority 1: Core crash information
            if (bugCheckCode) addSection('bugcheck', `\n**Bug Check:** ${bugCheckCode}`, 1);

            // Crash location from the kernel dump's exception address and module
            // ranges. The module name is read from the dump file, which may be
            // crafted, so it is framed as dump evidence rather than verified fact
            // (kernelDumpModuleParser only keeps file-name-shaped names; #150).
            if (accurateModuleInfo?.culpritModule) {
                const culpritInfo = `\n**Crash location (exception address matched to the dump's loaded-module ranges):**
The exception occurred at address ${accurateModuleInfo.exception.address ? `0x${accurateModuleInfo.exception.address.toString(16)}` : 'unknown'}, inside the module named **${accurateModuleInfo.culpritModule}** in the dump's module list.
Use this module as the crash location rather than guessing a different driver.`;
                addSection('verified_culprit', culpritInfo, 1);
            }

            if (windowsVersion) addSection('windows', `\n**Windows Version:** ${windowsVersion}`, 1);
            if (crashTime) addSection('time', `\n**Crash Time:** ${crashTime}`, 1);

            // Priority 2: Structured dump analysis
            const structuredDumpInfo = `\n\n**Structured Dump Analysis:**
${structuredInfo.dumpHeader ? `
Dump Header:
- Signature: ${structuredInfo.dumpHeader.signature}
- Version: ${structuredInfo.dumpHeader.majorVersion || 0}.${structuredInfo.dumpHeader.minorVersion || 0}
${structuredInfo.dumpHeader.machineImageType ? `- Machine Type: ${formatMachineType(structuredInfo.dumpHeader.machineImageType)}` : ''}
` : ''}

${structuredInfo.bugCheckInfo ? `
Bug Check Information:
- Code: ${formatBugCheckHex(structuredInfo.bugCheckInfo.code)} (${structuredInfo.bugCheckInfo.name})
- Parameter 1: 0x${structuredInfo.bugCheckInfo.parameter1.toString(16)}
- Parameter 2: 0x${structuredInfo.bugCheckInfo.parameter2.toString(16)}
- Parameter 3: 0x${structuredInfo.bugCheckInfo.parameter3.toString(16)}
- Parameter 4: 0x${structuredInfo.bugCheckInfo.parameter4.toString(16)}
` : ''}`;
            
            addSection('structured', structuredDumpInfo, 2);

            // Note: Stack traces removed - small memory dumps don't contain real stack data
            // The crash location and loaded modules from accurateModuleInfo are more reliable

            // Priority 3: Hex dump (adjust size based on remaining tokens)
            const remainingTokens = TARGET_TOKENS - currentTokens;
            const hexDumpSize = Math.min(
                PROCESSING_LIMITS.HEX_DUMP_LENGTH,
                Math.floor(remainingTokens * 0.1 * 4) // Use up to 10% of remaining tokens
            );
            let adjustedHexDump = generateRedactedHexDump(fileBuffer, hexDumpSize, personalNames);
            
            // CRITICAL: Also sanitize hex dump to prevent confusion
            // Remove any occurrences of "65F4" in hex that might confuse the AI
            adjustedHexDump = adjustedHexDump.replace(/65\s*F4/gi, 'XX XX');
            // Also remove fake driver signatures that might appear in hex
            adjustedHexDump = adjustedHexDump.replace(/77\s*58\s*72/gi, 'XX XX XX'); // wXr
            adjustedHexDump = adjustedHexDump.replace(/77\s*45\s*42/gi, 'XX XX XX'); // wEB
            adjustedHexDump = adjustedHexDump.replace(/76\s*53/gi, 'XX XX'); // vS
            
            addSection('hexdump', `\n\n**Binary Dump Analysis (${hexDumpSize} bytes):**
\`\`\`hex
${adjustedHexDump}
\`\`\``, 4);
            
            // Priority 5: Stack memory
            if (stackData) {
                addSection('stackmem', stackData, 5);
            }
            
            // Priority 6: Thread information
            if (threadInfo) {
                addSection('threads', `\n\n**Additional Thread Information:**\n${threadInfo}`, 6);
            }
            
            // Priority 7: Module list - prefer accurate parser when available
            // Use accurate module list from kernelDumpModuleParser if we have it
	            if (accurateModuleInfo?.modules && accurateModuleInfo.modules.length > 0) {
	                const moduleCount = Math.min(accurateModuleInfo.modules.length, 50); // Limit to 50 modules
	                const moduleSection = `\n\n**Loaded Module List from the Dump (${moduleCount} of ${accurateModuleInfo.modules.length}):**
	Do NOT reference any module that is not in this list.
	${accurateModuleInfo.modules.slice(0, moduleCount).map(m => `- ${m.name}`).join('\n')}`;
	                addSection('modules', moduleSection, 7);
	            } else {
                // Fallback to old parser's module list
                const legitimateModules = structuredInfo.moduleList.filter(m => isLegitimateModuleName(m.name));
                const moduleCount = Math.min(
                    legitimateModules.length,
                    Math.floor((remainingTokens - currentTokens) * 0.05 * 4 / 100)
                );
                if (moduleCount > 0) {
                    const moduleSection = `\n\n**Module List from Dump (${moduleCount} of ${legitimateModules.length}):**
${legitimateModules.slice(0, moduleCount).map(m => `- ${m.name}`).join('\n')}`;
	                    addSection('modules', moduleSection, 7);
	                }
	            }

	            if (outdatedDrivers.length > 0) {
	                const outdatedSection = `\n\n**Driver Version Warnings:**
	${outdatedDrivers.map(driver => `- ${driver.name} ${driver.version}: ${driver.status}`).join('\n')}`;
	                addSection('outdatedDrivers', outdatedSection, 7);
	            }

	            // Priority 8: Extracted strings (use remaining tokens)
            const stringTokensAvailable = Math.max(0, TARGET_TOKENS - currentTokens - 10000); // Reserve 10k for analysis requirements
            const maxStringLength = Math.min(
                extractedStrings.length,
                stringTokensAvailable * 4 // Convert tokens to characters
            );
            
            // CRITICAL: Remove potentially confusing bug-check-like values from
            // strings WITHOUT the old blanket rewrite: redacting every 4-8 digit
            // hex run mangled version numbers, timestamps and memory addresses.
            let adjustedStrings = extractedStrings.substring(0, maxStringLength);

            const realBugCheckHex = structuredInfo.bugCheckInfo ?
                formatBugCheckHex(structuredInfo.bugCheckInfo.code).slice(2) : '';

            // Redact hex only where it sits in an explicit bug-check context
            // (e.g. "BUGCHECK_CODE: 000000D1") and conflicts with the real code.
            const bugcheckContextPattern = /\b(bugcheck(?:_code)?\s*[:=]?\s*)(?:0x)?([0-9A-Fa-f]{4,8})\b/gi;
            adjustedStrings = adjustedStrings.replace(bugcheckContextPattern, (match, prefix: string, hex: string) => {
                const normalized = hex.toUpperCase().replace(/^0+/, '');
                const realNormalized = realBugCheckHex ? realBugCheckHex.toUpperCase().replace(/^0+/, '') : '';
                if (!realBugCheckHex || normalized === realNormalized) {
                    return match; // keep the genuine bug check evidence
                }
                console.log(`[Analyzer] Removing conflicting bug check code in context: ${hex}`);
                return `${prefix}[REDACTED_CODE]`;
            });

            // Known hallucinated token from earlier prompt-injection findings.
            adjustedStrings = adjustedStrings.replace(/\b65F4\b/gi, '[REDACTED_HEX]');
            
            // Also remove fake driver names that AI hallucinates
            adjustedStrings = adjustedStrings.replace(FAKE_DRIVER_PATTERN, '[REDACTED_DRIVER].sys');
            
            addSection('strings', `\n\n**Extracted String Data (${adjustedStrings.length} of ${rawExtractedStrings.length} chars):**
\`\`\`
${adjustedStrings}
\`\`\``, 8);
            
            // Build final prompt from sections
            const orderedSections = Object.keys(promptSections)
                .filter(k => k !== 'essential')
                .sort((a, b) => {
                    const priorities: { [key: string]: number } = {
                        bugcheck: 1, windows: 1, time: 1,
	                        structured: 2, stack: 3, hexdump: 4,
	                        stackmem: 5, threads: 6, modules: 7, outdatedDrivers: 7, strings: 8
                    };
                    return (priorities[a] || 99) - (priorities[b] || 99);
                });
            
            // Assemble dump-specific evidence only; the invariant analysis
            // instructions live in LOCAL_DUMP_PREFIX (shared, cache-stable) and
            // are prepended via wrapWithEvidence() below.
            let evidence = promptSections.essential;
            for (const section of orderedSections) {
                evidence += promptSections[section] || '';
            }

            // Authoritative bug check for this dump (the shared prefix tells the
            // model to use ONLY what appears here in the DUMP EVIDENCE section).
            if (structuredInfo.bugCheckInfo) {
                evidence += `
### ⚠️ BUG CHECK DETECTED: ${structuredInfo.bugCheckInfo.name}
**Code:** ${formatBugCheckHex(structuredInfo.bugCheckInfo.code)}
**Parameters:**
- Arg1: 0x${structuredInfo.bugCheckInfo.parameter1.toString(16).padStart(16, '0')}
- Arg2: 0x${structuredInfo.bugCheckInfo.parameter2.toString(16).padStart(16, '0')}
- Arg3: 0x${structuredInfo.bugCheckInfo.parameter3.toString(16).padStart(16, '0')}
- Arg4: 0x${structuredInfo.bugCheckInfo.parameter4.toString(16).padStart(16, '0')}

**CRITICAL:** You MUST interpret these parameters specifically for ${structuredInfo.bugCheckInfo.name}:
${getBugCheckParameterMeaning(structuredInfo.bugCheckInfo.code, [
    structuredInfo.bugCheckInfo.parameter1,
    structuredInfo.bugCheckInfo.parameter2,
    structuredInfo.bugCheckInfo.parameter3,
    structuredInfo.bugCheckInfo.parameter4
])}`;
            } else {
                evidence += '\n\n### ⚠️ NO BUG CHECK CODE FOUND\nAnalyze crash based on exception data, stack trace, and string patterns.';
            }
            
            // Dump strings go to the AI provider and are stored with the
            // report: redact profile folder names and email addresses first
            // (issue #345).
            const prompt = wrapWithEvidence(LOCAL_DUMP_PREFIX, redactPersonalIdentifiers(evidence, { names: personalNames }));
            
            // Log final token usage
            const finalTokens = estimateTokens(prompt);
            console.log(`[Analyzer] Final prompt size: ${prompt.length} chars, ~${finalTokens} tokens (${(finalTokens / MAX_TOKENS * 100).toFixed(1)}% of limit)`);
            
            // Generate the analysis — pass the file hash so server-side caching
            // keys on dump content (enabling the hash fast path) instead of the
            // prompt text alone.
            throwIfAborted();
            let report = await generateInitialAnalysis(fileLabel, prompt, dumpFile.fileHash, options?.signal);

            // If AI failed but we have accurate structured data, generate a basic analysis
            if (report.summary.includes('malformed response') && (accurateModuleInfo || structuredInfo.bugCheckInfo)) {
                console.log('[Analyzer] AI response failed but we have structured data - generating fallback analysis');
                const bugName = accurateModuleInfo?.bugCheck?.name ?? structuredInfo.bugCheckInfo?.name ?? 'UNKNOWN';
                const bugCode = accurateModuleInfo?.bugCheck?.code ?? structuredInfo.bugCheckInfo?.code ?? 0;
                const bugCodeHex = formatBugCheckHex(bugCode);
                const culprit = accurateModuleInfo?.culpritModule ?? 'Unknown driver';

                report = {
                    summary: `${bugName} (${bugCodeHex}) crash detected. The system encountered a critical error in ${culprit}.`,
                    probableCause: `This ${bugName} error indicates ${getBugCheckDescription(bugCode)}. The crash occurred in or was triggered by ${culprit}.`,
                    culprit: culprit,
                    recommendations: getBasicRecommendations(bugCode, culprit)
                };
            }

            // Enhance report with pattern-based recommendations
            if (report && structuredInfo.bugCheckInfo) {
                const bugCheckName = structuredInfo.bugCheckInfo.name;
                const pattern = findMatchingPattern(bugCheckName, extractedStrings);
                
                if (pattern) {
                    // Get enhanced recommendations
                    const enhancedRecs = getEnhancedRecommendations(
                        bugCheckName,
                        report.culprit,
                        extractedStrings
                    );
                    
                    // Merge with AI recommendations, removing duplicates
                    const allRecs = [...report.recommendations, ...enhancedRecs];
                    report.recommendations = [...new Set(allRecs)].slice(0, 10);
                }
                
                // Add crash severity to summary if critical
                if (crashContext && crashContext.severity === 'critical') {
                    report.summary = `[CRITICAL] ${report.summary}`;
                }
                
                // Ensure the summary mentions the correct bug check code
                const bugCheckStr = formatBugCheckHex(structuredInfo.bugCheckInfo.code);
                if (!report.summary.includes(bugCheckStr) && !report.summary.includes(structuredInfo.bugCheckInfo.name)) {
                    report.summary = `${structuredInfo.bugCheckInfo.name} (${bugCheckStr}) - ${report.summary}`;
                }
            }
            
            // Use verified culprit from accurate kernel dump parsing
            if (report && accurateModuleInfo?.culpritModule) {
                if (report.culprit !== accurateModuleInfo.culpritModule) {
                    console.log(`[Analyzer] Using culprit from the kernel dump's exception address: '${accurateModuleInfo.culpritModule}' (was: '${report.culprit}')`);
                    report.culprit = accurateModuleInfo.culpritModule;
                }
            }

            // Validate bug check code - AI must not change it
            if (report && structuredInfo.bugCheckInfo) {
                const correctBugCheckCode = `${formatBugCheckHex(structuredInfo.bugCheckInfo.code)} (${structuredInfo.bugCheckInfo.name})`;
                const correctBugCheckHex = formatBugCheckHex(structuredInfo.bugCheckInfo.code);

                // Check if report has bugCheckCode field
                if ('bugCheckCode' in report && report.bugCheckCode !== correctBugCheckCode) {
                    console.warn(`[Analyzer] AI returned incorrect bug check code: ${report.bugCheckCode}, correcting to: ${correctBugCheckCode}`);
                    report.bugCheckCode = correctBugCheckCode;
                }

                // Fix any hallucinated bug check codes. Only values presented in
                // an explicit bug-check context are rewritten — the same scoping
                // the extracted-strings pass uses above. A blanket hex scan here
                // would corrupt NTSTATUS codes, exception codes and 64-bit
                // addresses that legitimately appear in the prose.
                const bugcheckValuePattern = /\b(bug\s?check(?:\s+code)?|bugcheck(?:_code)?|stop\s+code)\b(\s*[:=]?\s*)((?:0x)?[0-9A-Fa-f]{1,16})\b/gi;
                const normalizeBugCheckHex = (value: string): string =>
                    value.toUpperCase().replace(/^0X0+/, '0X');

                // Fix summary
                if (report.summary) {
                    report.summary = report.summary.replace(bugcheckValuePattern, (match, prefix: string, sep: string, hex: string) => {
                        if (normalizeBugCheckHex(hex) === normalizeBugCheckHex(correctBugCheckHex)) {
                            return match; // already the verified code
                        }
                        console.warn(`[Analyzer] Replacing fake bug check ${hex} in summary`);
                        return `${prefix}${sep}${correctBugCheckHex}`;
                    });
                    report.summary = report.summary.replace(/UNKNOWN_BUG_CHECK_[0-9A-Fx]+/gi, structuredInfo.bugCheckInfo.name);
                }

                // Fix probable cause
                const fakeDrivers = [...FAKE_DRIVER_SYS, ...FAKE_DRIVERS];
                if (report.probableCause) {
                    report.probableCause = report.probableCause.replace(bugcheckValuePattern, (match, prefix: string, sep: string, hex: string) => {
                        if (normalizeBugCheckHex(hex) === normalizeBugCheckHex(correctBugCheckHex)) {
                            return match; // already the verified code
                        }
                        console.warn(`[Analyzer] Replacing fake bug check ${hex} in probable cause`);
                        return `${prefix}${sep}${correctBugCheckHex}`;
                    });

                    for (const fakeDriver of fakeDrivers) {
                        if (report.probableCause.includes(fakeDriver)) {
                            console.warn(`[Analyzer] Removing fake driver ${fakeDriver} from probable cause`);
                            report.probableCause = report.probableCause.replace(new RegExp(fakeDriver + '[^\\s]*', 'gi'), '[driver name could not be determined]');
                        }
                    }
                }

                // Fix culprit if it's a fake driver
                const fakeCulprits = FAKE_DRIVER_SYS;
                if (fakeCulprits.includes(report.culprit)) {
                    console.warn(`[Analyzer] Detected fake culprit ${report.culprit}`);
                    // Use verified culprit from module info, or indicate unknown
                    if (accurateModuleInfo?.culpritModule) {
                        report.culprit = accurateModuleInfo.culpritModule;
                    } else {
                        report.culprit = 'Could not determine culprit driver';
                        console.warn('[Analyzer] Could not determine real culprit from available data');
                    }
                }
            }

            // === ENHANCED REPORT DATA ===
            // Add structured data for improved UI display

            // Bug Check with parameter meanings
            if (structuredInfo.bugCheckInfo || accurateModuleInfo?.bugCheck) {
                const bugCode = accurateModuleInfo?.bugCheck?.code ?? structuredInfo.bugCheckInfo?.code ?? 0;
                const bugName = accurateModuleInfo?.bugCheck?.name ?? structuredInfo.bugCheckInfo?.name ?? 'UNKNOWN';
                const params = accurateModuleInfo?.bugCheck?.parameters ?? [
                    BigInt(structuredInfo.bugCheckInfo?.parameter1 ?? 0),
                    BigInt(structuredInfo.bugCheckInfo?.parameter2 ?? 0),
                    BigInt(structuredInfo.bugCheckInfo?.parameter3 ?? 0),
                    BigInt(structuredInfo.bugCheckInfo?.parameter4 ?? 0)
                ];

                // Get parameter explanations from crash database
                report.bugCheck = {
                    code: formatBugCheckHex(bugCode),
                    name: bugName,
                    parameters: params.map((p, i) => ({
                        value: `0x${p.toString(16)}`,
                        meaning: getParameterExplanation(bugCode, (i + 1) as 1 | 2 | 3 | 4, p)
                    }))
                };
            }

            // Crash Location with module offset
            if (accurateModuleInfo?.culpritModule && accurateModuleInfo?.exception) {
                const excAddr = accurateModuleInfo.exception.address;
                const culpritMod = accurateModuleInfo.modules.find(m => m.name === accurateModuleInfo.culpritModule);
                let offset: string | undefined;
                if (culpritMod && excAddr >= culpritMod.base) {
                    offset = `+0x${(excAddr - culpritMod.base).toString(16)}`;
                }
                report.crashLocation = {
                    module: accurateModuleInfo.culpritModule,
                    address: `0x${excAddr.toString(16)}`,
                    offset
                };
            }

            // Register Context
            if (structuredInfo.threadContext) {
                const ctx = structuredInfo.threadContext;
                report.registers = {};
                // x64 registers available in ThreadContext
                if (ctx.rip !== undefined) report.registers.rip = `0x${ctx.rip.toString(16)}`;
                if (ctx.rsp !== undefined) report.registers.rsp = `0x${ctx.rsp.toString(16)}`;
                if (ctx.rbp !== undefined) report.registers.rbp = `0x${ctx.rbp.toString(16)}`;
            }

            // Loaded Modules (prefer accurate parser)
            const modules = accurateModuleInfo?.modules ?? structuredInfo.moduleList ?? [];
            if (modules.length > 0) {
                report.loadedModules = modules
                    .slice(0, 50)
                    .filter(m => m && m.name)
                    .map(m => ({
                        name: m.name,
                        base: m.base !== undefined ? `0x${m.base.toString(16)}` : undefined,
                        size: m.size ? `0x${m.size.toString(16)}` : undefined,
                        isCulprit: m.name === (accurateModuleInfo?.culpritModule ?? report.culprit)
                    }));
            }

            // Driver warnings and hardware error info come from AI response
            // Log if AI returned driver warnings
            if (report.driverWarnings && report.driverWarnings.length > 0) {
                console.log(`[Analyzer] AI identified ${report.driverWarnings.length} driver warnings`);
            }

            // Log if AI detected hardware error
            if (report.hardwareError?.isHardwareError) {
                console.log(`[Analyzer] AI detected hardware error: ${report.hardwareError.errorType} in ${report.hardwareError.component}`);

                // Add hardware-specific recommendations from AI to the beginning
                if (report.hardwareError.recommendations?.length > 0) {
                    const existingRecs = new Set(report.recommendations.map(r => r.toLowerCase()));
                    for (const rec of report.hardwareError.recommendations.slice(0, 3)) {
                        if (!existingRecs.has(rec.toLowerCase())) {
                            report.recommendations.unshift(rec); // Add at beginning for priority
                        }
                    }
                }
            }

            // Log parameter analysis from AI
            if (report.parameterAnalysis && report.parameterAnalysis.length > 0) {
                console.log(`[Analyzer] AI provided ${report.parameterAnalysis.length} parameter analyses`);
            }

            return { id: dumpFile.id, report, status: FileStatus.ANALYZED, analysisMethod: 'local' as const };
        } catch (error) {
	            console.error(`Analysis failed for ${fileLabel}:`, error);
            return { id: dumpFile.id, error: `Failed to read or analyze file. ${(error as Error).message}`, status: FileStatus.ERROR };
        }
        })();

        return result;
    };

    const results: Array<FileAnalysisResult | undefined> = new Array(files.length);
    let nextIndex = 0;

    const workers = Array.from({ length: Math.min(MAX_CLIENT_ANALYSIS_CONCURRENCY, files.length) }, async () => {
        while (nextIndex < files.length && !options?.signal?.aborted) {
            const index = nextIndex++;
            const result = await analyzeFile(files[index]);
            results[index] = result;
            if (onFileComplete && !options?.signal?.aborted) {
                onFileComplete(result);
            }
        }
    });

    await Promise.all(workers);

    return results.map((result, index) => result ?? {
        id: files[index].id,
        error: 'Analysis was cancelled before this file started',
        status: FileStatus.ERROR
    });
};
