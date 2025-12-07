// Proxy to match the original geminiService.ts exactly but route through backend
import { DumpFile, AnalysisReportData, FileStatus } from '../types';
import { sanitizeExtractedContent, sanitizeHexDump, validateProcessingTimeout } from '../utils/contentSanitizer';
import { initializeSession, handleSessionError } from '../utils/sessionManager';
import { getStructuredDumpInfo, extractBugCheckInfo, isLegitimateModuleName } from '../utils/dumpParser';
import { parseDumpFile as parseKernelDump, KernelDumpResult } from '../utils/kernelDumpModuleParser';
import { findMatchingPattern, getEnhancedRecommendations, analyzeCrashContext } from '../utils/knownPatterns';
import { getParameterExplanation } from '../utils/crashPatternDatabase';
import { PROCESSING_LIMITS } from '../constants';
import { executeAnalyzeV, executeLmKv, executeProcess00, executeVm } from '../utils/windbgCommands';
import { analyzeMemoryPatterns } from '../utils/memoryPatternAnalyzer';
import { extractDriverVersions, identifyOutdatedDrivers } from '../utils/peParser';
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
        
        if (!data.text) {
            console.warn('[GeminiProxy] Response has no text field:', Object.keys(data));
        }
        
        // Log thinking process if available (for debugging)
        if (data.candidates?.[0]?.content?.thinking) {
            console.log('[AI] Model thinking process available');
            // Note: We don't expose thinking to the client for now
        }
        
        return {
            text: data.text || ''
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
    },
    required: ["summary", "probableCause", "culprit", "recommendations"],
};

// --- Binary Processing Helpers ---

const readFileAsArrayBuffer = (file: File): Promise<ArrayBuffer> => {
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
        reader.readAsArrayBuffer(file);
    });
};

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
- Arg2: 0=Read, 1=Write, 2=Execute (${params[2]})
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
        return `0x${bugCheckInfo.code.toString(16).padStart(8, '0').toUpperCase()} (${bugCheckInfo.name})`;
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

    // Common recommendations
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
                    return date.toISOString().replace('T', ' ').replace('.000Z', ' UTC');
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
    let result = '';
    let currentString = '';
    
    // ASCII strings
    for (let i = 0; i < view.length; i++) {
        // Check timeout periodically
        if (i % 10000 === 0 && !validateProcessingTimeout(startTime)) {
            console.warn('String extraction timed out');
            break;
        }
        
        const charCode = view[i];
        if (charCode >= 32 && charCode <= 126) {
            currentString += String.fromCharCode(charCode);
        } else {
            if (currentString.length >= minLength) {
                result += currentString + '\n';
            }
            currentString = '';
        }
    }
    if (currentString.length >= minLength) {
        result += currentString + '\n';
    }

    // UTF-16LE strings
    const dataView = new DataView(buffer);
    currentString = '';
     for (let i = 0; i < buffer.byteLength - 1; i += 2) {
        try {
            const charCode = dataView.getUint16(i, true); // true for little-endian
            if (charCode >= 32 && charCode <= 126) { // Simple check for printable range
                currentString += String.fromCharCode(charCode);
            } else {
                 if (currentString.length >= minLength) {
                    result += currentString + '\n';
                }
                currentString = '';
            }
        } catch (e) {
            // Reached end of buffer
            break;
        }
    }
    if (currentString.length >= minLength) {
        result += currentString;
    }

    return result.replace(new RegExp('(\\r\\n|\\n|\\r)', 'gm'), "\n"); // Normalize newlines
}

// Legacy function kept for compatibility - actual sanitization happens in sanitizeHexDump
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


const generateInitialAnalysis = async (fileName: string, prompt: string): Promise<AnalysisReportData> => {
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
            }
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
            return parsedJson as AnalysisReportData;
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
                        return parsedJson as AnalysisReportData;
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

// Add global error handler for debugging
if (typeof window !== 'undefined') {
    window.addEventListener('error', (event) => {
        console.error('[Global Error]', event.error);
        console.error('[Global Error Stack]', event.error?.stack);
    });
}

export const analyzeDumpFiles = async (files: DumpFile[]) => {
    const analysisPromises = files.map(async (dumpFile) => {
        try {
            console.log('[Analyzer] Starting analysis for:', dumpFile.file.name);
            const fileBuffer = await readFileAsArrayBuffer(dumpFile.file);
            console.log('[Analyzer] File buffer loaded, size:', fileBuffer.byteLength);

            // AdvancedDumpParser removed - using accurate kernelDumpModuleParser instead

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
                `0x${structuredInfo.bugCheckInfo.code.toString(16).padStart(8, '0').toUpperCase()} (${structuredInfo.bugCheckInfo.name})` :
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
                memoryPatternAnalysis = analyzeMemoryPatterns(fileBuffer);
                console.log('[Analyzer] Memory pattern analysis complete:', memoryPatternAnalysis.summary);
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
                    const MinidumpParser = (await import('../utils/minidumpStreams.js')).MinidumpParser;
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
            const TARGET_TOKENS = 50000;
            const MAX_TOKENS = 100000;
            
            // Build prompt sections with token tracking
            let currentTokens = 0;
            const promptSections: { [key: string]: string } = {};
            
            // Essential sections (always include) - simplified with accurate parsing
            const essentialPrefix = `Analyze this Windows crash dump. Use ONLY the verified data provided.

**File:** ${dumpFile.file.name} (${dumpFile.dumpType}, ${dumpFile.file.size} bytes)`;
            
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
- Code: 0x${structuredInfo.bugCheckInfo.code.toString(16).padStart(8, '0').toUpperCase()} (${structuredInfo.bugCheckInfo.name})
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
                structuredInfo.bugCheckInfo.code.toString(16).padStart(8, '0').toUpperCase() : '';
            
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
            const fakeDriverPattern = /\b(wXr|wEB|vS)\.sys\b/gi;
            adjustedStrings = adjustedStrings.replace(fakeDriverPattern, '[REDACTED_DRIVER].sys');
            
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
                        stackmem: 5, threads: 6, modules: 7, strings: 8
                    };
                    return (priorities[a] || 99) - (priorities[b] || 99);
                });
            
            let prompt = promptSections.essential;
            for (const section of orderedSections) {
                prompt += promptSections[section] || '';
            }
            
            // Add analysis requirements
            prompt += `\n\n## CRASH ANALYSIS REQUIREMENTS\n\n`;
            
            // Add analysis requirements based on bug check info
            if (structuredInfo.bugCheckInfo) {
                prompt += `
### ⚠️ BUG CHECK DETECTED: ${structuredInfo.bugCheckInfo.name}
**Code:** 0x${structuredInfo.bugCheckInfo.code.toString(16).padStart(8, '0').toUpperCase()}
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
                prompt += '\n### ⚠️ NO BUG CHECK CODE FOUND\nAnalyze crash based on exception data, stack trace, and string patterns.';
            }
            
            // Add analysis instructions
            prompt += `

### ANALYSIS INSTRUCTIONS:

1. **Root Cause Analysis**
   - Identify the EXACT faulting module from the stack trace or strings
   - Explain WHY this specific crash occurred based on the bug check parameters
   - Reference specific evidence from the hex dump or strings

2. **Evidence-Based Diagnosis**
   - Quote specific driver names, error messages, or patterns from the data
   - Identify the crash progression through the stack frames
   - Note any memory corruption indicators (bad pool headers, invalid addresses)

3. **Targeted Solutions**
   - Provide solutions SPECIFIC to the identified cause
   - Reference the actual driver/component names found in the dump
   - Prioritize based on the bug check type and parameters

### IMPORTANT RULES:
- Only analyze what's IN THIS DUMP - no generic advice
- **NEVER change or infer a different bug check code** - use ONLY the one explicitly stated above
- The bug check code has been DEFINITIVELY IDENTIFIED as shown above - DO NOT suggest any other code
- If the stack trace shows a specific driver, that's likely the culprit
- Bug check parameters are CRITICAL - they tell you exactly what went wrong
- Look for patterns: all zeros = freed memory, all FFs = uninitialized
- Recent timestamps in module list = recently loaded/updated drivers

### CRITICAL WARNING:
**You MUST use the bug check code ${structuredInfo.bugCheckInfo ? '0x' + structuredInfo.bugCheckInfo.code.toString(16).padStart(8, '0').toUpperCase() + ' (' + structuredInfo.bugCheckInfo.name + ')' : 'provided above'} in your analysis. Do NOT mention or suggest any other bug check code!**

**ABSOLUTELY FORBIDDEN:**
- DO NOT mention bug check 0x65F4 or any custom/non-standard bug check codes
- DO NOT invent security software crashes unless explicitly shown in the data
- DO NOT fabricate driver names like wXr.sys, wEB.sys, vS.sys unless they appear in the strings
- DO NOT create fictional stack traces - use ONLY frames found in the extracted data

**The ACTUAL bug check is ${structuredInfo.bugCheckInfo ? structuredInfo.bugCheckInfo.name + ' (0x' + structuredInfo.bugCheckInfo.code.toString(16).padStart(8, '0').toUpperCase() + ')' : 'shown above'} - anything else is WRONG!**

### VALIDATION CHECK:
The extracted bug check from this dump is: ${structuredInfo.bugCheckInfo ? '0x' + structuredInfo.bugCheckInfo.code.toString(16).padStart(8, '0').toUpperCase() + ' (' + structuredInfo.bugCheckInfo.name + ')' : 'UNKNOWN'}
- If you mention ANY other bug check code, your analysis will be rejected
- Common REAL bug checks: 0x1E, 0x50, 0x7E, 0x8E, 0xA, 0x124, 0xD1, 0x9F, 0xF5
- FAKE bug checks to NEVER use: 0x65F4, 0x1234, any custom codes

### DRIVER VALIDATION:
Do NOT invent fake driver names like wXr.sys, wEB.sys, vS.sys - only mention drivers that appear in the module list.
`;
            
            // Log final token usage
            const finalTokens = estimateTokens(prompt);
            console.log(`[Analyzer] Final prompt size: ${prompt.length} chars, ~${finalTokens} tokens (${(finalTokens / MAX_TOKENS * 100).toFixed(1)}% of limit)`);
            
            // Generate the analysis
            let report = await generateInitialAnalysis(dumpFile.file.name, prompt);

            // If AI failed but we have accurate structured data, generate a basic analysis
            if (report.summary.includes('malformed response') && (accurateModuleInfo || structuredInfo.bugCheckInfo)) {
                console.log('[Analyzer] AI response failed but we have structured data - generating fallback analysis');
                const bugName = accurateModuleInfo?.bugCheck?.name ?? structuredInfo.bugCheckInfo?.name ?? 'UNKNOWN';
                const bugCode = accurateModuleInfo?.bugCheck?.code ?? structuredInfo.bugCheckInfo?.code ?? 0;
                const bugCodeHex = `0x${bugCode.toString(16).padStart(8, '0').toUpperCase()}`;
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
                const pattern = findMatchingPattern(bugCheckName, rawExtractedStrings);
                
                if (pattern) {
                    // Get enhanced recommendations
                    const enhancedRecs = getEnhancedRecommendations(
                        bugCheckName,
                        report.culprit,
                        rawExtractedStrings
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
                const bugCheckStr = `0x${structuredInfo.bugCheckInfo.code.toString(16).padStart(8, '0').toUpperCase()}`;
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
                const correctBugCheckCode = `0x${structuredInfo.bugCheckInfo.code.toString(16).padStart(8, '0').toUpperCase()} (${structuredInfo.bugCheckInfo.name})`;
                const correctBugCheckHex = `0x${structuredInfo.bugCheckInfo.code.toString(16).padStart(8, '0').toUpperCase()}`;

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
                const fakeDrivers = ['wXr.sys', 'wEB.sys', 'vS.sys', 'wXr', 'wEB', 'vS'];
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
                const fakeCulprits = ['wXr.sys', 'wEB.sys', 'vS.sys'];
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
                    code: `0x${bugCode.toString(16).padStart(8, '0').toUpperCase()}`,
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

            return { id: dumpFile.id, report, status: FileStatus.ANALYZED };
        } catch (error) {
            console.error(`Analysis failed for ${dumpFile.file.name}:`, error);
            return { id: dumpFile.id, error: `Failed to read or analyze file. ${(error as Error).message}`, status: FileStatus.ERROR };
        }
    });

    return Promise.all(analysisPromises);
};

const getAdvancedPrompt = (tool: string, dumpFile: DumpFile, extractedStrings: string, hexDump: string): string => {
    const { report, file, dumpType } = dumpFile;
    if (!report) return `Error: No report available for ${file.name}.`;

    const baseIntro = `You are a world-class Windows kernel debugger (WinDbg). You are performing a deep analysis of a ${dumpType} dump file named "${file.name}".
An initial analysis was performed, identifying "${report.culprit}" as the likely culprit with the summary: "${report.summary}".
You now have access to the raw data extracted from the dump file to perform more specific commands. Do NOT simulate. Your output must be based on the provided data.
**Important:** Do NOT include any debugger tool headers, loading messages, or command prompts (e.g., "kd>"). Your response must be ONLY the direct output of the command, formatted as requested.`;

    const dataContext = `
--- DATA FROM ${file.name} ---
HEX DUMP (first ${PROCESSING_LIMITS.HEX_DUMP_LENGTH} bytes):
${hexDump}

EXTRACTED STRINGS (first ${PROCESSING_LIMITS.MAX_STRINGS_LENGTH} chars):
${extractedStrings}
--- END DATA ---
`;

    switch (tool) {
        case '!analyze -v':
            return `${baseIntro}
Your task is to act as the '!analyze -v' command and provide a detailed analysis.
**Format your entire response in Markdown.**
- Start with the bug check analysis, using headings and code blocks for technical details like the bug check code, parameters, and the reconstructed stack trace.
- Provide a detailed "Conclusion" or "Analysis Summary" section using bold text, paragraphs, and lists to explain the findings.
- Finish with a bulleted list of actionable "Recommendations".
- Your analysis must be derived from the provided HEX DUMP and EXTRACTED STRINGS. Do not invent details that cannot be inferred from the data.
${dataContext}`;
        case '!vm':
            return `${baseIntro}
Your task is to generate the output for the '!vm' command.
Use the provided data to generate a plausible summary of virtual memory usage that is consistent with the initial crash analysis.
**Your entire output must be raw text inside a single Markdown code block**, formatted like the WinDbg console output.
${dataContext}`;
        case '!process 0 0':
            return `${baseIntro}
Your task is to generate the output for the '!process 0 0' command.
Scan the EXTRACTED STRINGS for any process names (.exe files). List these and other common system processes.
**Your entire output must be raw text inside a single Markdown code block**, formatted like the WinDbg console output.
${dataContext}`;
        case 'lm kv':
            return `${baseIntro}
Your task is to generate the output for the 'lm kv' command.
Scan the EXTRACTED STRINGS for module names (.sys, .dll files). Pay special attention to the culprit driver: ${report.culprit}.
**Your entire output must be raw text inside a single Markdown code block**, formatted like the WinDbg console output.
${dataContext}`;
        default:
            return `${baseIntro}\n\nAn unknown command was requested: ${tool}. Provide an error message indicating the command is not supported.`;
    }
};


export const runAdvancedAnalysis = async (tool: string, dumpFile: DumpFile): Promise<string> => {
    if (!dumpFile.report) {
        throw new Error("Cannot run advanced analysis without an initial report.");
    }
    
    // Re-process the file to get the data needed for the prompt.
    const fileBuffer = await readFileAsArrayBuffer(dumpFile.file);
    
    try {
        // Use real WinDbg command implementations
        let result: string;
        
        switch (tool) {
            case '!analyze -v': {
                const commandResult = executeAnalyzeV(fileBuffer);
                if (commandResult.success) {
                    // Format as markdown for better presentation
                    result = `## !analyze -v\n\n\`\`\`\n${commandResult.output}\n\`\`\``;
                } else {
                    result = `Error executing !analyze -v: ${commandResult.error}`;
                }
                break;
            }
            
            case 'lm kv': {
                const commandResult = executeLmKv(fileBuffer);
                if (commandResult.success) {
                    result = `## lm kv\n\n\`\`\`\n${commandResult.output}\n\`\`\``;
                } else {
                    result = `Error executing lm kv: ${commandResult.error}`;
                }
                break;
            }
            
            case '!process 0 0': {
                const commandResult = executeProcess00(fileBuffer);
                if (commandResult.success) {
                    result = `## !process 0 0\n\n\`\`\`\n${commandResult.output}\n\`\`\``;
                } else {
                    result = `Error executing !process 0 0: ${commandResult.error}`;
                }
                break;
            }
            
            case '!vm': {
                const commandResult = executeVm(fileBuffer);
                if (commandResult.success) {
                    result = `## !vm\n\n\`\`\`\n${commandResult.output}\n\`\`\``;
                } else {
                    result = `Error executing !vm: ${commandResult.error}`;
                }
                break;
            }
            
            default: {
                // Fall back to AI analysis for unknown commands
                const MAX_STRINGS_LENGTH = PROCESSING_LIMITS.MAX_STRINGS_LENGTH;
                const rawExtractedStrings = extractPrintableStrings(fileBuffer);
                const extractedStrings = sanitizeExtractedContent(rawExtractedStrings).substring(0, MAX_STRINGS_LENGTH);
                const hexDump = sanitizeHexDump(fileBuffer);
                
                const prompt = getAdvancedPrompt(tool, dumpFile, extractedStrings, hexDump);
                
                const ai = createGeminiProxy();
                const response = await ai.models.generateContent({
                    contents: prompt,
                    config: {
                        temperature: 0.1,
                    },
                    tools: [{
                        googleSearch: {
                            // Enable dynamic retrieval for better grounding
                            dynamicRetrievalConfig: {
                                mode: "MODE_DYNAMIC",
                                dynamicThreshold: 0.7  // Higher threshold for more relevant results
                            }
                        }
                    }]
                });
                return response.text;
            }
        }
        
        return result;
        
    } catch (error) {
        console.error(`Error running advanced analysis for ${dumpFile.file.name} with tool ${tool}:`, error);
        throw new Error(`Failed to run advanced analysis tool ${tool}.`);
    }
};