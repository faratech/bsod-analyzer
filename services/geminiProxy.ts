// Proxy to match the original geminiService.ts exactly but route through backend
import { DumpFile, AnalysisReportData, FileStatus, StackFrame, SystemInfo } from '../types';
import { sanitizeExtractedContent, validateProcessingTimeout } from '../utils/contentSanitizer';
import { initializeSession, handleSessionError } from '../utils/sessionManager';
import { getStructuredDumpInfo, extractBugCheckInfo, isLegitimateModuleName } from '../utils/dumpParser';
import { parseDumpFile as parseKernelDump, KernelDumpResult } from '../utils/kernelDumpModuleParser';
import { findMatchingPattern, getEnhancedRecommendations, analyzeCrashContext } from '../utils/knownPatterns';
import { getParameterExplanation } from '../utils/crashPatternDatabase';
import { FILE_SIZE_THRESHOLDS, PROCESSING_LIMITS } from '../constants';
import { analyzeMemoryPatterns } from '../utils/memoryPatternAnalyzer';
import { extractDriverVersions, identifyOutdatedDrivers } from '../utils/peParser';
import { MinidumpParser } from '../utils/minidumpStreams.js';
import { analyzeWithWinDBG, getCachedAnalysisByHash, WinDBGAnalysisResult } from './windbgService';
import { LOCAL_DUMP_PREFIX, WINDBG_PREFIX, WINDBG_OUTPUT_MARKER, wrapWithEvidence } from '../shared/promptTemplates.js';
import { extractFullAnalyzeOutput } from '../shared/windbgApiClient.js';
import { getLargeDumpSampleRanges, shouldUseLightweightAiFailover } from '../shared/windbgFailoverPolicy.js';
import { isPremiumTier } from './tierState';
import { SSO_ENABLED } from './featureFlags';
import { extractWinDbgWindowsVersion } from '../shared/windowsVersion.js';
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

        const makeRequest = async (): Promise<any> => {
            try {
                // Log the request size for debugging
                const requestBody = JSON.stringify(params);
                console.log('[GeminiProxy] Request size:', requestBody.length, 'bytes');
                if (requestBody.length > 1000000) {
                    console.warn('[GeminiProxy] Large request size may cause issues');
                }

                const response = await fetch('/api/gemini/generateContent', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    credentials: 'include', // Important: include cookies for session
                    body: requestBody
                });

                if (!response.ok) {
                    let errorMessage = `API request failed with status ${response.status}`;
                    let errorData: any = {};

                    try {
                        errorData = await response.json();
                        console.error('[GeminiProxy] Error response:', errorData);
                    } catch {
                        // Response might not be JSON
                        try {
                            const errorText = await response.text();
                            console.error('[GeminiProxy] Error response text:', errorText);
                            errorMessage += `: ${errorText}`;
                        } catch {
                            console.error('[GeminiProxy] Could not read error response');
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
                        errorMessage = 'Server error - the Gemini API key may not be configured';
                    } else if (response.status === 413) {
                        errorMessage = 'Request too large - the dump file may be too big';
                    } else if (response.status === 429) {
                        errorMessage = 'Rate limit exceeded - too many requests';
                    }

                    throw new Error(errorData.error || errorMessage);
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
        culprit: { type: Type.STRING, description: "The driver or system file causing the crash. Use ONLY the verified culprit from VERIFIED CRASH LOCATION if provided." },
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
        const isHardwareError = Boolean(hardware.isHardwareError || hardware.errorType || hardware.type);
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

function compactWindowsBuild(version: unknown): string | undefined {
    if (typeof version !== 'string') return undefined;
    const text = version.trim();
    const match = /^10\.0\.(\d{5}\.\d+)$/i.exec(text);
    return match ? match[1] : text || undefined;
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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

function isKnownBugCheck(code: number): boolean {
    // List of known valid Windows bug check codes
    const knownBugChecks = [
        0x00000001, 0x00000002, 0x00000003, 0x00000004, 0x00000005,
        0x00000007, 0x0000000A, 0x0000000B, 0x0000000C, 0x0000000D,
        0x0000000E, 0x0000000F, 0x00000010, 0x00000012, 0x00000013,
        0x00000014, 0x00000018, 0x00000019, 0x0000001A, 0x0000001C,
        0x0000001D, 0x0000001E, 0x00000020, 0x00000021, 0x00000022,
        0x00000023, 0x00000024, 0x00000025, 0x00000026, 0x00000027,
        0x00000028, 0x00000029, 0x0000002A, 0x0000002B, 0x0000002C,
        0x0000002D, 0x0000002E, 0x0000002F, 0x00000030, 0x00000031,
        0x00000032, 0x00000033, 0x00000034, 0x00000035, 0x00000036,
        0x00000037, 0x00000039, 0x0000003A, 0x0000003B, 0x0000003C,
        0x0000003D, 0x0000003E, 0x0000003F, 0x00000040, 0x00000041,
        0x00000042, 0x00000044, 0x00000045, 0x00000046, 0x00000047,
        0x00000048, 0x0000004A, 0x0000004B, 0x0000004C, 0x0000004D,
        0x0000004E, 0x00000050, 0x00000051, 0x00000052, 0x00000053,
        0x00000054, 0x00000055, 0x00000056, 0x00000057, 0x00000058,
        0x00000059, 0x0000005A, 0x0000005C, 0x0000005D, 0x0000005E,
        0x0000005F, 0x00000060, 0x00000061, 0x00000062, 0x00000063,
        0x00000064, 0x00000065, 0x00000066, 0x00000067, 0x00000068,
        0x00000069, 0x0000006A, 0x0000006B, 0x0000006C, 0x0000006D,
        0x0000006E, 0x0000006F, 0x00000070, 0x00000071, 0x00000072,
        0x00000073, 0x00000074, 0x00000075, 0x00000076, 0x00000077,
        0x00000078, 0x00000079, 0x0000007A, 0x0000007B, 0x0000007C,
        0x0000007D, 0x0000007E, 0x0000007F, 0x00000080, 0x00000081,
        0x00000082, 0x00000085, 0x00000086, 0x0000008B, 0x0000008E,
        0x0000008F, 0x00000090, 0x00000092, 0x00000093, 0x00000094,
        0x00000096, 0x00000097, 0x00000098, 0x00000099, 0x0000009A,
        0x0000009B, 0x0000009C, 0x0000009E, 0x0000009F, 0x000000A0,
        0x000000A1, 0x000000A2, 0x000000A3, 0x000000A4, 0x000000A5,
        0x000000A7, 0x000000AB, 0x000000AC, 0x000000AD, 0x000000B1,
        0x000000B4, 0x000000B8, 0x000000B9, 0x000000BA, 0x000000BB,
        0x000000BC, 0x000000BD, 0x000000BE, 0x000000BF, 0x000000C1,
        0x000000C2, 0x000000C4, 0x000000C5, 0x000000C6, 0x000000C7,
        0x000000C8, 0x000000C9, 0x000000CA, 0x000000CB, 0x000000CC,
        0x000000CD, 0x000000CE, 0x000000CF, 0x000000D0, 0x000000D1,
        0x000000D2, 0x000000D3, 0x000000D4, 0x000000D5, 0x000000D6,
        0x000000D7, 0x000000D8, 0x000000D9, 0x000000DA, 0x000000DB,
        0x000000DC, 0x000000DD, 0x000000DE, 0x000000DF, 0x000000E0,
        0x000000E1, 0x000000E2, 0x000000E3, 0x000000E4, 0x000000E6,
        0x000000E7, 0x000000E8, 0x000000E9, 0x000000EA, 0x000000EB,
        0x000000EC, 0x000000ED, 0x000000EF, 0x000000F0, 0x000000F1,
        0x000000F2, 0x000000F3, 0x000000F4, 0x000000F5, 0x000000F6,
        0x000000F7, 0x000000F8, 0x000000F9, 0x000000FA, 0x000000FB,
        0x000000FC, 0x000000FD, 0x000000FE, 0x000000FF, 0x00000100,
        0x00000101, 0x00000102, 0x00000103, 0x00000104, 0x00000105,
        0x00000106, 0x00000107, 0x00000108, 0x00000109, 0x0000010A,
        0x0000010C, 0x0000010D, 0x0000010E, 0x0000010F, 0x00000111,
        0x00000112, 0x00000113, 0x00000114, 0x00000115, 0x00000116,
        0x00000117, 0x00000119, 0x0000011A, 0x0000011B, 0x0000011C,
        0x0000011D, 0x00000121, 0x00000122, 0x00000124, 0x00000125,
        0x00000126, 0x00000127, 0x00000128, 0x00000129, 0x0000012A,
        0x0000012B, 0x0000012C, 0x0000012D, 0x0000012E, 0x0000012F,
        0x00000130, 0x00000131, 0x00000132, 0x00000133, 0x00000134,
        0x00000135, 0x00000136, 0x00000137, 0x00000138, 0x00000139,
        0x0000013A, 0x0000013B, 0x0000013C, 0x0000013D, 0x0000013E,
        0x0000013F, 0x00000140, 0x00000141, 0x00000142, 0x00000143,
        0x00000144, 0x00000145, 0x00000146, 0x00000147, 0x00000148,
        0x00000149, 0x0000014A, 0x0000014B, 0x0000014C, 0x0000014D,
        0x0000014E, 0x0000014F, 0x00000150, 0x00000151, 0x00000152,
        0x00000153, 0x00000154, 0x00000155, 0x00000156, 0x00000157,
        0x00000158, 0x00000159, 0x0000015A, 0x0000015B, 0x0000015C,
        0x0000015D, 0x0000015E, 0x0000015F, 0x00000160, 0x00000161,
        0x00000162, 0x00000163, 0x00000164, 0x00000165, 0x00000166,
        0x00000167, 0x00000168, 0x00000169, 0x0000016A, 0x0000016B,
        0x0000016C, 0x0000016D, 0x0000016E, 0x0000016F, 0x00000170,
        0x00000171, 0x00000172, 0x00000173, 0x00000174, 0x00000175,
        0x00000176, 0x00000177, 0x00000178, 0x00000179, 0x0000017A,
        0x0000017B, 0x0000017C, 0x0000017D, 0x0000017E, 0x0000017F,
        0x00000180, 0x00000181, 0x00000182, 0x00000183, 0x00000184,
        0x00000185, 0x00000186, 0x00000187, 0x00000188, 0x00000189,
        0x0000018A, 0x0000018B, 0x0000018C, 0x0000018D, 0x0000018E,
        0x0000018F, 0x00000190, 0x00000191, 0x00000192, 0x00000193,
        0x00000194, 0x00000195, 0x00000196, 0x00000197, 0x00000198,
        0x00000199, 0x0000019A, 0x0000019B, 0x0000019C, 0x0000019D,
        0x0000019E, 0x0000019F, 0x000001A0, 0x000001A1, 0x000001A2,
        0x000001A3, 0x000001A4, 0x000001A5, 0x000001A6, 0x000001A7,
        0x000001A8, 0x000001AA, 0x000001AB, 0x000001AC, 0x000001AD,
        0x000001AE, 0x000001AF, 0x000001B0, 0x000001B1, 0x000001B2,
        0x000001B3, 0x000001B4, 0x000001B5, 0x000001B6, 0x000001B7,
        0x000001B8, 0x000001B9, 0x000001BA, 0x000001BB, 0x000001BC,
        0x000001BD, 0x000001BE, 0x000001BF, 0x000001C0, 0x000001C1,
        0x000001C2, 0x000001C3, 0x000001C4, 0x000001C5, 0x000001C6,
        0x000001C7, 0x000001C8, 0x000001C9, 0x000001CA, 0x000001CB,
        0x000001CC, 0x000001CD, 0x000001CE, 0x000001CF, 0x000001D0,
        0x000001D1, 0x000001D2, 0x000001D3, 0x000001D4, 0x000001D5,
        0x000001D6, 0x000001D7, 0x000001D8, 0x000001D9, 0x000001DA,
        0x000001DB, 0x000001DC, 0x000001DD, 0x000001DE, 0x000001DF,
        0x000001E0, 0x000001E1, 0x000001E2, 0x000001E3, 0x000001E4,
        0x000001E5, 0x000001E6, 0x000001E7, 0x000001E8, 0x000001E9,
        0x000001EA, 0x000001EB, 0x000001EC, 0x000001ED, 0x000001EE,
        0x000001EF, 0x000001F0, 0x000001F1, 0x000001F2, 0x000001F3,
        0x000001F4, 0x000001F5, 0x000001F6, 0x000001F7, 0x000001F8,
        0x000001F9, 0x000001FA, 0x000001FB, 0x000001FC, 0x000001FD,
        0x000001FE, 0x000001FF, 0x00000200, 0x00000201, 0x00000202,
        0x00000203, 0x00000204, 0x00000205, 0x00000206, 0x00000207,
        0x00000208, 0x00000209, 0x0000020A, 0x0000020B, 0x0000020C,
        0x0000020D, 0x0000020E, 0x0000020F, 0x00000210, 0x00000211,
        0x00000212, 0x00000213, 0x00000214, 0x00000215, 0x00000216,
        0x00000217, 0x00000218, 0x00000219, 0x0000021A, 0x0000021B,
        0x00000356, 0x00000357, 0x00000358, 0x00000359, 0x00000BFE,
        0x00020001, 0x1000007E, 0x1000007F, 0x1000008E, 0x100000EA,
        0xC0000218, 0xC0000221, 0xC000021A, 0xC0000420, 0xC0000421,
        0xDEADDEAD
    ];
    
    return knownBugChecks.includes(code);
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
    return descriptions[code] || 'a critical system error requiring analysis';
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


const generateInitialAnalysis = async (fileName: string, prompt: string, fileHash?: string): Promise<AnalysisReportData> => {
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
                maxOutputTokens: 4096,
            },
            fileHash // Pass fileHash for cache key consistency
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
        
        // Check if it's an API configuration error
        if (error instanceof Error && error.message.includes('API request failed')) {
            throw new Error(`API request failed for ${fileName}. Please ensure the Gemini API key is configured on the server.`);
        }
        
        throw new Error(`Failed to generate analysis for ${fileName}. ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
};

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error || 'Unknown WinDBG failure');
}

function formatSampleRanges(ranges: Array<{ label: string; start: number; end: number }>): string {
    return ranges
        .map(range => `${range.label}: bytes ${range.start}-${Math.max(range.start, range.end - 1)} (${range.end - range.start} bytes)`)
        .join('; ');
}

async function generateLargeDumpAiFailoverReport(
    dumpFile: DumpFile,
    fileLabel: string,
    windbgFailure: unknown
): Promise<AnalysisReportData> {
    console.log('[Analyzer] Using lightweight AI failover for large dump:', fileLabel);
    const { buffer: sampledBuffer, ranges } = await readSampledDumpBuffer(dumpFile.file);
    const rawExtractedStrings = extractPrintableStrings(sampledBuffer);
    const extractedStrings = sanitizeExtractedContent(rawExtractedStrings)
        .substring(0, PROCESSING_LIMITS.MAX_STRINGS_LENGTH);
    const bugCheckCode = extractBugCheckCode(sampledBuffer);
    const windowsVersion = extractWindowsVersion(rawExtractedStrings);
    const sampleHexDump = generateHexDump(sampledBuffer, PROCESSING_LIMITS.HEX_DUMP_LENGTH);
    const samplingSummary = formatSampleRanges(ranges);

    let evidence = `**File:** ${fileLabel} (${dumpFile.dumpType}, ${dumpFile.file.size} bytes)

**Fallback Mode:** WinDBG server was unavailable, so this is a lightweight AI failover analysis using sampled dump bytes only.
**WinDBG Failure:** ${errorMessage(windbgFailure).slice(0, 500)}
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

    const prompt = wrapWithEvidence(LOCAL_DUMP_PREFIX, evidence);
    const report = await generateInitialAnalysis(fileLabel, prompt, dumpFile.fileHash);

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

function normalizeBugCheckParameterValues(parameters: unknown): string[] {
    return Array.isArray(parameters)
        ? parameters
            .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            .map(value => value.trim())
        : [];
}

function parseHexBigInt(value: string): bigint {
    const hex = value.replace(/^0x/i, '').replace(/`/g, '').trim();
    return /^[0-9a-f]+$/i.test(hex) ? BigInt(`0x${hex}`) : 0n;
}

function mapStructuredSignalToReport(structured: Record<string, unknown> | undefined): Partial<AnalysisReportData> {
    if (!structured || typeof structured !== 'object') return {};

    const bugcheck = structured.bugcheck && typeof structured.bugcheck === 'object'
        ? structured.bugcheck as Record<string, unknown>
        : {};
    const crash = structured.crash && typeof structured.crash === 'object'
        ? structured.crash as Record<string, unknown>
        : {};
    const target = structured.target && typeof structured.target === 'object'
        ? structured.target as Record<string, unknown>
        : {};
    const process = structured.process && typeof structured.process === 'object'
        ? structured.process as Record<string, unknown>
        : {};
    const execution = structured.execution && typeof structured.execution === 'object'
        ? structured.execution as Record<string, unknown>
        : {};

    const result: Partial<AnalysisReportData> = {};
    const bugCode = stringValue(bugcheck.code);
    const bugName = stringValue(bugcheck.name);
    const parameters = normalizeBugCheckParameterValues(bugcheck.parameters);
    if (bugCode || bugName || parameters.length > 0) {
        result.bugCheck = {
            code: bugCode || 'Unknown',
            name: bugName || 'UNKNOWN',
            parameters: parameters.map((value, index) => ({
                value,
                meaning: getParameterExplanation(
                    Number.parseInt((bugCode || '').replace(/^0x/i, ''), 16) || 0,
                    (index + 1) as 1 | 2 | 3 | 4,
                    parseHexBigInt(value)
                )
            }))
        };
    }

    result.failureBucketId = stringValue(crash.failureBucketId);
    result.symbolName = stringValue(crash.symbolName);
    result.moduleName = stringValue(crash.moduleName);
    result.imageName = stringValue(crash.imageName);
    result.imageVersion = stringValue(crash.imageVersion);
    result.imageBuild = compactWindowsBuild(result.imageVersion);
    result.faultAddress = stringValue(crash.readAddress);

    const systemInfo: SystemInfo = {};
    const osVersion = stringValue(target.os_version) || stringValue(target.osVersion);
    const uptime = stringValue(target.system_uptime) || stringValue(target.systemUptime);
    const processName = stringValue(crash.processName) || stringValue(process.name) || stringValue(process.imageName);
    if (osVersion) systemInfo.windowsVersion = osVersion;
    if (uptime) systemInfo.systemUptime = uptime;
    if (processName) systemInfo.processName = processName;
    if (result.imageName && /^nt(?:krnlmp|oskrnl)\.exe$/i.test(result.imageName) && result.imageVersion) {
        systemInfo.kernelImageVersion = result.imageVersion;
        systemInfo.kernelBuild = compactWindowsBuild(result.imageVersion);
    }
    if (Object.keys(systemInfo).length > 0) result.systemInfo = systemInfo;

    if (structured.registers && typeof structured.registers === 'object') {
        result.registers = structured.registers as AnalysisReportData['registers'];
    }

    if (Array.isArray(structured.stackFrames)) {
        result.callStack = structured.stackFrames
            .filter((frame): frame is Record<string, unknown> => !!frame && typeof frame === 'object')
            .map(frame => {
                const symbol = stringValue(frame.symbol);
                const match = symbol?.match(/^([^!]+)!([^+]+)(?:\+(.+))?$/);
                return {
                    address: stringValue(frame.sp) || stringValue(frame.ret_addr) || stringValue(frame.address) || 'unknown',
                    module: match?.[1] || stringValue(frame.module) || 'unknown',
                    function: match?.[2] || stringValue(frame.function),
                    offset: match?.[3] || stringValue(frame.offset)
                };
            })
            .slice(0, 20);
    }

    if (Array.isArray(structured.notableModules)) {
        const mappedModules = structured.notableModules
            .filter((mod): mod is Record<string, unknown> => !!mod && typeof mod === 'object')
            .map(mod => {
                const details = mod.details && typeof mod.details === 'object' ? mod.details as Record<string, unknown> : {};
                const name = stringValue(mod.name) || stringValue(details.imageName) || 'unknown';
                const imageName = stringValue(details.imageName);
                const version = stringValue(details.fileVersion) || stringValue(details.productVersion);
                if (/^nt(?:krnlmp|oskrnl)?$/i.test(name) && imageName && /^nt(?:krnlmp|oskrnl)\.exe$/i.test(imageName) && version) {
                    systemInfo.kernelImageVersion = version;
                    systemInfo.kernelBuild = compactWindowsBuild(version);
                    result.imageName = result.imageName || imageName;
                    result.imageVersion = result.imageVersion || version;
                    result.imageBuild = result.imageBuild || compactWindowsBuild(version);
                }
                return {
                    name,
                    base: stringValue(mod.base),
                    version,
                    timestamp: stringValue(details.timestamp),
                    isCulprit: name.toLowerCase() === stringValue(result.moduleName)?.toLowerCase()
                };
            })
            .slice(0, 30);
        result.loadedModules = mappedModules;
        if (Object.keys(systemInfo).length > 0) result.systemInfo = systemInfo;
    }

    if (execution.timedOut === true && !result.summary) {
        result.summary = 'WinDbg analysis timed out before all evidence could be collected.';
    }

    return result;
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
    } = {}
): Promise<AnalysisReportData> {
    console.log('[Analyzer] Generating AI report from WinDBG analysis...');
    console.log('[Analyzer] WinDBG analysis length:', windbgAnalysis.length, 'chars');

    // Parse structured fields directly from WinDBG output (more reliable than AI extraction)
    const parsedFields = parseWinDbgOutput(windbgAnalysis);
    const structuredFields = mapStructuredSignalToReport(options.structured);
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
${structuredSignal ? 'Relevant structured JSON extracted from the WinDBG API result. Full stdout is intentionally omitted.' : 'Relevant WinDBG crash excerpt from the raw output.'}
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
                temperature: 0.5,
                maxOutputTokens: 4096
            },
            fileHash // Pass fileHash for cache key consistency
        });

        const responseText = response.text;
        console.log('[Analyzer] WinDBG AI response length:', responseText.length);

        // Parse the JSON response
        try {
            const aiReport = normalizeAnalysisReportData(JSON.parse(responseText));
            console.log('[Analyzer] Successfully parsed WinDBG-based report');
            // Merge AI report with directly parsed fields (parsed fields take precedence for structured data)
            const mergedReport = {
                ...aiReport,
                ...structuredFields,
                ...parsedFields,
                // Preserve AI's systemInfo but merge with parsed
                systemInfo: { ...aiReport.systemInfo, ...structuredFields.systemInfo, ...parsedFields.systemInfo }
            };
            console.log('[Analyzer] Merged report has:', {
                failureBucketId: mergedReport.failureBucketId || 'missing',
                symbolName: mergedReport.symbolName || 'missing',
                kernelBuild: mergedReport.systemInfo?.kernelBuild || 'missing',
                rawWinDbgOutput: mergedReport.rawWinDbgOutput ? `${mergedReport.rawWinDbgOutput.length} chars` : 'missing',
                callStack: mergedReport.callStack?.length || 0
            });
            return normalizeAnalysisReportData(mergedReport);
        } catch (parseError) {
            console.error('[Analyzer] Failed to parse WinDBG AI response:', parseError);

            // Try to extract JSON from the response
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    const aiReport = normalizeAnalysisReportData(JSON.parse(jsonMatch[0]));
                    console.log('[Analyzer] Extracted JSON from WinDBG response');
                    return normalizeAnalysisReportData({
                        ...aiReport,
                        ...structuredFields,
                        ...parsedFields,
                        systemInfo: { ...aiReport.systemInfo, ...structuredFields.systemInfo, ...parsedFields.systemInfo }
                    });
                } catch {
                    // Continue to fallback
                }
            }

            // Return a basic report from WinDBG output with parsed fields
            return {
                summary: `Windows crash analyzed via WinDBG for ${fileName}`,
                probableCause: 'Analysis completed by WinDBG server. See raw output for details.',
                culprit: extractCulpritFromWinDBG(windbgAnalysis),
                recommendations: [
                    'Review the full WinDBG analysis output',
                    'Update the identified driver if applicable',
                    'Check for Windows updates',
                    'Run system file checker (sfc /scannow)'
                ],
                ...structuredFields,
                ...parsedFields
            };
        }
    } catch (error) {
        console.error('[Analyzer] WinDBG AI analysis error:', error);

        // Return a basic report if AI fails, still include parsed fields
        return {
            summary: `Windows crash in ${fileName} analyzed by WinDBG`,
            probableCause: 'WinDBG analysis completed but AI interpretation failed.',
            culprit: extractCulpritFromWinDBG(windbgAnalysis),
            recommendations: [
                'Review the raw WinDBG output manually',
                'Update drivers mentioned in the analysis',
                'Check Windows Event Viewer for related errors'
            ],
            ...structuredFields,
            ...parsedFields
        };
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

function extractVersionFromModuleBlock(block: string): string | undefined {
    const patterns = [
        /^\s*File version:\s*(10\.0\.\d{5}\.\d+)\b/im,
        /^\s*ProductVersion:\s*(10\.0\.\d{5}\.\d+)\b/im,
        /^\s*FileVersion:\s*(10\.0\.\d{5}\.\d+)\b/im,
        /^\s*IMAGE_VERSION:\s*(10\.0\.\d{5}\.\d+)\b/im
    ];
    for (const pattern of patterns) {
        const match = block.match(pattern);
        if (match) return match[1];
    }
    return undefined;
}

function extractKernelImageVersion(output: string): string | undefined {
    const blocks = output.split(/(?=^[0-9a-f`]+\s+[0-9a-f`]+\s+\S+\s)/gim);
    for (const block of blocks) {
        if (!/^[0-9a-f`]+\s+[0-9a-f`]+\s+(?:nt|ntkrnlmp|ntoskrnl)\s/im.test(block)) continue;
        if (!/\b(?:Loaded symbol image file|Image name):\s+nt(?:krnlmp|oskrnl)\.exe\b/i.test(block)) continue;
        const version = extractVersionFromModuleBlock(block);
        if (version) return version;
    }

    const imageName = output.match(/^\s*IMAGE_NAME:\s*(\S+)/im)?.[1];
    if (imageName && /^nt(?:krnlmp|oskrnl)\.exe$/i.test(imageName)) {
        return output.match(/^\s*IMAGE_VERSION:\s*(10\.0\.\d{5}\.\d+)\b/im)?.[1];
    }
    return undefined;
}

/**
 * Parse additional structured data from WinDBG raw output.
 * This extracts fields that the AI might miss or misinterpret.
 */
function parseWinDbgOutput(output: string): Partial<AnalysisReportData> {
    const result: Partial<AnalysisReportData> = {};

    console.log('[WinDBG Parser] Parsing output of length:', output.length);
    console.log('[WinDBG Parser] First 500 chars:', output.substring(0, 500));

    // Extract FAILURE_BUCKET_ID - highly searchable crash signature
    const bucketMatch = output.match(/FAILURE_BUCKET_ID:\s*(.+)/i);
    if (bucketMatch) {
        result.failureBucketId = bucketMatch[1].trim();
        console.log('[WinDBG Parser] Found failureBucketId:', result.failureBucketId);
    } else {
        console.log('[WinDBG Parser] No FAILURE_BUCKET_ID found');
    }

    // Extract SYMBOL_NAME - precise crash location
    const symbolMatch = output.match(/SYMBOL_NAME:\s*(.+)/i);
    if (symbolMatch) {
        result.symbolName = symbolMatch[1].trim();
        console.log('[WinDBG Parser] Found symbolName:', result.symbolName);
    }

    const moduleMatch = output.match(/MODULE_NAME:\s*(\S+)/i);
    if (moduleMatch) {
        result.moduleName = moduleMatch[1].trim();
    }

    const imageMatch = output.match(/IMAGE_NAME:\s*(\S+)/i);
    if (imageMatch) {
        result.imageName = imageMatch[1].trim();
    }

    const imageVersionMatch = output.match(/IMAGE_VERSION:\s*(.+)/i);
    if (imageVersionMatch) {
        result.imageVersion = imageVersionMatch[1].trim();
        result.imageBuild = compactWindowsBuild(result.imageVersion);
    }

    // Extract fault address from various sources
    const faultAddrMatch = output.match(/TRAP_FRAME:.*Rip\s*=\s*([0-9a-fA-F`]+)/i) ||
                           output.match(/FAULTING_IP:\s*\S+\s*([0-9a-fA-F`]+)/i) ||
                           output.match(/READ_ADDRESS:\s*([0-9a-fA-F`]+)/i) ||
                           output.match(/WRITE_ADDRESS:\s*([0-9a-fA-F`]+)/i);
    if (faultAddrMatch) {
        result.faultAddress = faultAddrMatch[1].trim();
    }

    // Extract system info
    const systemInfo: SystemInfo = {};

    // PROCESS_NAME
    const processMatch = output.match(/PROCESS_NAME:\s*(\S+)/i);
    if (processMatch) {
        systemInfo.processName = processMatch[1];
    }

    // Windows version from OS-specific WinDBG fields. Avoid arbitrary module
    // ProductVersion values from lm kv output, which can look like 103.4.x.
    const windowsVersion = extractWinDbgWindowsVersion(output);
    if (windowsVersion) {
        systemInfo.windowsVersion = windowsVersion;
    }

    const kernelImageVersion = extractKernelImageVersion(output);
    if (kernelImageVersion) {
        systemInfo.kernelImageVersion = kernelImageVersion;
        systemInfo.kernelBuild = compactWindowsBuild(kernelImageVersion);
    } else if (result.imageName && /^nt(?:krnlmp|oskrnl)\.exe$/i.test(result.imageName) && result.imageVersion) {
        systemInfo.kernelImageVersion = result.imageVersion;
        systemInfo.kernelBuild = compactWindowsBuild(result.imageVersion);
    }

    // System uptime
    const uptimeMatch = output.match(/SYSTEM_UPTIME:\s*(.+)/i);
    if (uptimeMatch) {
        systemInfo.systemUptime = uptimeMatch[1].trim();
    }

    if (Object.keys(systemInfo).length > 0) {
        result.systemInfo = systemInfo;
    }

    // Parse STACK_TEXT for call stack
    const stackMatch = output.match(/STACK_TEXT:\s*([\s\S]*?)(?=\n\n[A-Z_]+:|CHKIMG_EXTENSION|SYMBOL_NAME|\n\nFOLLOWUP|$)/i);
    if (stackMatch) {
        result.callStack = parseStackText(stackMatch[1]);
    }

    // Expose the complete !analyze -v output for advanced users. Fall back to
    // the aggregated WinDBG text only for older server responses that do not
    // preserve command sections.
    result.rawWinDbgOutput = extractFullAnalyzeOutput(output) || output;

    console.log('[WinDBG Parser] Parse result summary:', {
        hasFailureBucketId: !!result.failureBucketId,
        hasSymbolName: !!result.symbolName,
        hasFaultAddress: !!result.faultAddress,
        hasSystemInfo: !!result.systemInfo,
        callStackFrames: result.callStack?.length || 0,
        rawOutputLength: result.rawWinDbgOutput?.length || 0
    });

    return result;
}

/**
 * Parse the STACK_TEXT section from WinDBG output into structured frames.
 */
function parseStackText(stackText: string): StackFrame[] {
    const frames: StackFrame[] = [];
    const lines = stackText.split('\n');

    for (const line of lines) {
        // WinDBG stack format: "fffff807`12345678 nt!KeBugCheckEx+0x0"
        // Or: "00000000`12345678 module!Function+0x123"
        const match = line.match(/^\s*([0-9a-fA-F`]+)\s+(\S+?)!([^+\s]+)(?:\+0x([0-9a-fA-F]+))?/);
        if (match) {
            frames.push({
                address: match[1],
                module: match[2],
                function: match[3],
                offset: match[4] ? `0x${match[4]}` : undefined
            });
        } else {
            // Try simpler format: "fffff807`12345678 00000000`00000000 : args"
            // This captures stack frames without symbols
            const addrMatch = line.match(/^\s*([0-9a-fA-F`]{16,17})\s+([0-9a-fA-F`]+)/);
            if (addrMatch && !line.includes('Args to Child')) {
                // Only add if we don't have a function name - less useful but still data
                frames.push({
                    address: addrMatch[1],
                    module: 'unknown',
                    function: undefined,
                    offset: undefined
                });
            }
        }

        // Limit to reasonable number of frames
        if (frames.length >= 20) break;
    }

    return frames;
}

export const analyzeDumpFiles = async (
    files: DumpFile[],
    onProgress?: (stage: 'uploading' | 'queued' | 'processing' | 'downloading' | 'analyzing' | 'complete', message: string) => void,
    onFileComplete?: (result: { id: string; report?: AnalysisReportData; error?: string; status: FileStatus; cached?: boolean; analysisMethod?: 'windbg' | 'local' }) => void,
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

    const analyzeFile = async (dumpFile: DumpFile): Promise<{ id: string; report?: AnalysisReportData; error?: string; status: FileStatus; cached?: boolean; analysisMethod?: 'windbg' | 'local' }> => {
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

            if (dumpFile.knownCached && dumpFile.fileHash) {
                try {
                    onProgress?.('downloading', 'Loading cached analysis...');
                    const cached = await getCachedAnalysisByHash(dumpFile.fileHash);
                    throwIfAborted();

                    if (cached?.cached) {
                        const cachedReport = normalizeCachedAIReport(cached.aiReport);
                        if (cachedReport) {
                            console.log(`[Analyzer] Cache HIT - using cached AI report for ${fileLabel}`);
                            return {
                                id: dumpFile.id,
                                report: cachedReport,
                                status: FileStatus.ANALYZED,
                                cached: true,
                                analysisMethod: cached.windbgAnalysis ? 'windbg' as const : 'local' as const
                            };
                        }

                        const cachedWinDbg = typeof cached.windbgAnalysis === 'string'
                            ? cached.windbgAnalysis.trim()
                            : '';
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
                                    structured: cached.structured || undefined
                                }
                            );
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
                } catch (cacheError) {
                    throwIfAborted();
                    console.warn('[Analyzer] Cached analysis retrieval failed; falling back to WinDBG upload:', cacheError);
                }
            }

            // Try WinDBG server analysis first
            let windbgResult: WinDBGAnalysisResult | null = null;
            let useLightweightAiFailover = false;
            let windbgFailure: unknown = null;
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
                windbgResult = await analyzeWithWinDBG(dumpFile.file, (stage, message) => {
                    console.log(`[WinDBG] ${stage}: ${message}`);
                    // Forward WinDBG progress to the UI
                    if (onProgress) {
                        onProgress(stage, message);
                    }
                }, onUploadProgress);

                if (windbgResult.success) {
                    console.log(`[Analyzer] WinDBG analysis successful (${windbgResult.processingTime}s)`);

                    // Signal that we're now in the AI analysis stage
                    if (onProgress) {
                        onProgress('analyzing', 'AI is interpreting the crash analysis...');
                    }

                    // Use WinDBG analysis to generate AI report
                    const windbgReport = await generateReportFromWinDBG(
                        fileLabel,
                        dumpFile.dumpType,
                        dumpFile.file.size,
                        windbgResult.analysisText,
                        windbgResult.fileHash,
                        {
                            analysisSignalText: windbgResult.analysisSignalText,
                            structured: windbgResult.structured
                        }
                    );

                    // Populate bugCheck from binary buffer (guarantees accurate code and parameters meanings)
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

	                                windbgReport.bugCheck = {
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

                    return {
                        id: dumpFile.id,
                        report: windbgReport,
                        status: FileStatus.ANALYZED,
                        cached: windbgResult.cached || false,
                        analysisMethod: 'windbg' as const
                    };
                } else {
                    console.log('[Analyzer] WinDBG analysis failed:', windbgResult.error);
                    if (/turnstile verification required/i.test(windbgResult.error || '')) {
                        throw new Error(windbgResult.error);
                    }
                    windbgFailure = windbgResult.error || 'WinDBG analysis failed';
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

            if (useLightweightAiFailover) {
                const report = await generateLargeDumpAiFailoverReport(dumpFile, fileLabel, windbgFailure);
                return { id: dumpFile.id, report, status: FileStatus.ANALYZED, analysisMethod: 'local' as const };
            }

            // Fallback: Use local analysis if WinDBG failed
            // AdvancedDumpParser removed - using accurate kernelDumpModuleParser instead
            const fileBuffer = await getFileBuffer();

            const MAX_STRINGS_LENGTH = PROCESSING_LIMITS.MAX_STRINGS_LENGTH;
            console.log('[Analyzer] Extracting printable strings...');
            const rawExtractedStrings = extractPrintableStrings(fileBuffer);
            console.log('[Analyzer] Extracted strings length:', rawExtractedStrings.length);
            
            const extractedStrings = sanitizeExtractedContent(rawExtractedStrings).substring(0, MAX_STRINGS_LENGTH);

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
                // Get more stack data if available (for MDMP minidumps only)
                if (structuredInfo.dumpHeader?.signature === 'MDMP') {
                    const parser = new MinidumpParser(fileBuffer);
                    const threads = parser.getThreads();
                    
                    if (threads.length > 0) {
                        // Get stack data from first thread
                        const thread = threads[0];
                        const stackMemory = parser.getThreadStack(thread.threadId);
                        
                        if (stackMemory && stackMemory.byteLength > 0) {
                            const stackHex = generateHexDump(stackMemory, Math.min(stackMemory.byteLength, PROCESSING_LIMITS.MAX_STACK_MEMORY_SIZE));
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

            // Add VERIFIED culprit module from accurate kernel dump parsing
            if (accurateModuleInfo?.culpritModule) {
                const culpritInfo = `\n**⚠️ VERIFIED CRASH LOCATION (from exception address matching):**
The exception occurred at address ${accurateModuleInfo.exception.address ? `0x${accurateModuleInfo.exception.address.toString(16)}` : 'unknown'} which is INSIDE the module: **${accurateModuleInfo.culpritModule}**
This is the DEFINITIVE crash location - do NOT guess a different driver.`;
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
${structuredInfo.dumpHeader.machineImageType ? `- Machine Type: ${structuredInfo.dumpHeader.machineImageType} (${structuredInfo.dumpHeader.machineImageType === 0x8664 ? 'x64' : 'x86'})` : ''}
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
            let adjustedHexDump = generateHexDump(fileBuffer, hexDumpSize);
            
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
	                const moduleSection = `\n\n**VERIFIED Module List (${moduleCount} of ${accurateModuleInfo.modules.length}):**
	IMPORTANT: Only these modules were loaded at crash time. Do NOT reference any module not in this list.
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
            
            // CRITICAL: Remove potentially confusing hex patterns from strings
            let adjustedStrings = extractedStrings.substring(0, maxStringLength);
            
            // Remove patterns that look like bug check codes but aren't the real one
            const realBugCheckHex = structuredInfo.bugCheckInfo ?
                formatBugCheckHex(structuredInfo.bugCheckInfo.code).slice(2) : '';
            
            // Pattern to match hex values that could be confused as bug check codes
            // This will match things like "65F4", "0x65F4", etc.
            const confusingHexPattern = /\b(0x)?([0-9A-Fa-f]{4,8})\b/g;
            
            adjustedStrings = adjustedStrings.replace(confusingHexPattern, (match, _prefix, hex) => {
                // Keep the real bug check code
                if (hex.toUpperCase() === realBugCheckHex || 
                    hex.toUpperCase() === realBugCheckHex.substring(4)) { // Last 4 digits
                    return match;
                }
                
                // Remove potentially confusing hex patterns
                const hexValue = parseInt(hex, 16);
                
                // Known patterns to remove:
                // - 65F4 and variations
                // - Any 4-digit hex that could be confused as a bug check
                if (hex.length === 4 && (hex.toUpperCase() === '65F4' || 
                    hexValue > 0x1000 && hexValue < 0xFFFF)) {
                    console.log(`[Analyzer] Removing confusing hex pattern: ${match}`);
                    return '[REDACTED_HEX]';
                }
                
                // Remove 8-digit hex that doesn't match known bug checks
                if (hex.length === 8 && !isKnownBugCheck(hexValue)) {
                    console.log(`[Analyzer] Removing potential fake bug check: ${match}`);
                    return '[REDACTED_CODE]';
                }
                
                return match;
            });
            
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
            
            const prompt = wrapWithEvidence(LOCAL_DUMP_PREFIX, evidence);
            
            // Log final token usage
            const finalTokens = estimateTokens(prompt);
            console.log(`[Analyzer] Final prompt size: ${prompt.length} chars, ~${finalTokens} tokens (${(finalTokens / MAX_TOKENS * 100).toFixed(1)}% of limit)`);
            
            // Generate the analysis
	            let report = await generateInitialAnalysis(fileLabel, prompt);

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
                    console.log(`[Analyzer] Using VERIFIED culprit from kernel dump: '${accurateModuleInfo.culpritModule}' (was: '${report.culprit}')`);
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

                // Fix any hallucinated bug check codes
                const fakeBugCheckPattern = /0x[0-9A-Fa-f]{4,8}/g;

                // Fix summary
                if (report.summary) {
                    const summaryMatches = report.summary.match(fakeBugCheckPattern) || [];
                    for (const match of summaryMatches) {
                        if (match !== correctBugCheckHex && match !== '0xFFFFFFFFC0000005') {
                            console.warn(`[Analyzer] Replacing fake bug check ${match} in summary`);
                            report.summary = report.summary.replace(new RegExp(match, 'gi'), correctBugCheckHex);
                        }
                    }
                    report.summary = report.summary.replace(/UNKNOWN_BUG_CHECK_[0-9A-Fx]+/gi, structuredInfo.bugCheckInfo.name);
                }

                // Fix probable cause
                const fakeDrivers = [...FAKE_DRIVER_SYS, ...FAKE_DRIVERS];
                if (report.probableCause) {
                    const causeMatches = report.probableCause.match(fakeBugCheckPattern) || [];
                    for (const match of causeMatches) {
                        if (match !== correctBugCheckHex && match !== '0xFFFFFFFFC0000005') {
                            console.warn(`[Analyzer] Replacing fake bug check ${match} in probable cause`);
                            report.probableCause = report.probableCause.replace(new RegExp(match, 'gi'), correctBugCheckHex);
                        }
                    }

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

    const results: Array<{ id: string; report?: AnalysisReportData; error?: string; status: FileStatus; cached?: boolean; analysisMethod?: 'windbg' | 'local' } | undefined> = new Array(files.length);
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
