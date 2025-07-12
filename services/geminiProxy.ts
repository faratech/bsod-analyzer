// Proxy to match the original geminiService.ts exactly but route through backend
import { DumpFile, AnalysisReportData, FileStatus } from '../types';

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

// Proxy class that mimics GoogleGenAI
class GoogleGenAI {
    private apiKey: string;
    public models: {
        generateContent: (params: any) => Promise<GenerateContentResponse>;
    };

    constructor(config: { apiKey: string }) {
        this.apiKey = config.apiKey;
        this.models = {
            generateContent: async (params: any) => {
                const response = await fetch('/api/gemini/generateContent', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(params)
                });

                if (!response.ok) {
                    throw new Error(`API request failed: ${response.statusText}`);
                }

                const data = await response.json();
                return {
                    text: data.text || ''
                };
            }
        };
    }
}

// Create proxy instance
const ai = new GoogleGenAI({ apiKey: 'proxy' });

const reportSchema = {
    type: Type.OBJECT,
    properties: {
        summary: { type: Type.STRING, description: "A brief, one-sentence summary of the crash." },
        probableCause: { type: Type.STRING, description: "A detailed but easy-to-understand explanation of the likely cause of the blue screen error, based on the provided data." },
        culprit: { type: Type.STRING, description: "The most likely driver or system file causing the crash (e.g., 'ntoskrnl.exe', 'nvlddmkm.sys', 'atikmdag.sys'), identified from the extracted strings or file patterns." },
        recommendations: { type: Type.ARRAY, items: { type: Type.STRING }, description: "A list of actionable steps the user should take to fix the issue." },
        stackTrace: { type: Type.ARRAY, items: { type: Type.STRING }, description: "A plausible kernel-mode stack trace with at least 5 levels, reconstructed from function names or patterns found in the EXTRACTED STRINGS. This should not be a generic simulation but based on evidence in the data." },
    },
    required: ["summary", "probableCause", "culprit", "recommendations", "stackTrace"],
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

function extractPrintableStrings(buffer: ArrayBuffer, minLength = 4): string {
    const view = new Uint8Array(buffer);
    let result = '';
    let currentString = '';
    
    // ASCII strings
    for (let i = 0; i < view.length; i++) {
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

    return result.replace(/(\r\n|\n|\r)/gm, "\n"); // Normalize newlines
}

function generateHexDump(buffer: ArrayBuffer, length = 1024): string {
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
        const response: GenerateContentResponse = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: reportSchema,
            },
        });

        let jsonText = response.text;
        
        // Clean up the response if it's wrapped in markdown code blocks
        if (jsonText.startsWith('```json')) {
            jsonText = jsonText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
        } else if (jsonText.startsWith('```')) {
            jsonText = jsonText.replace(/^```\s*/, '').replace(/\s*```$/, '');
        }
        
        // Trim any whitespace
        jsonText = jsonText.trim();
        
        const parsedJson = JSON.parse(jsonText);
        return parsedJson as AnalysisReportData;
    } catch (error) {
        console.error(`Error analyzing ${fileName}:`, error);
        throw new Error(`Failed to generate analysis for ${fileName}. The model response might be malformed.`);
    }
};

export const analyzeDumpFiles = async (files: DumpFile[]) => {
    const analysisPromises = files.map(async (dumpFile) => {
        try {
            const fileBuffer = await readFileAsArrayBuffer(dumpFile.file);

            const MAX_STRINGS_LENGTH = 25000;
            const extractedStrings = extractPrintableStrings(fileBuffer).substring(0, MAX_STRINGS_LENGTH);
            const hexDump = generateHexDump(fileBuffer, 1024);

            const prompt = `
Act as a world-class Windows kernel debugger analyzing a BSOD crash dump. You will be provided with data extracted directly from a dump file. Your task is to perform a root cause analysis based on this data.

**Dump File Information:**
- **Filename:** ${dumpFile.file.name}
- **Size:** ${dumpFile.file.size} bytes
- **Type:** ${dumpFile.dumpType} dump

**Extracted Data:**
Below is a Hex Dump of the beginning of the file, followed by printable strings found within the binary. These strings can contain crucial information like loaded modules, failing drivers, error messages, and system information.

--- HEX DUMP (first 1024 bytes) ---
${hexDump}
--- END HEX DUMP ---

--- EXTRACTED STRINGS (first ${MAX_STRINGS_LENGTH} chars) ---
${extractedStrings}
--- END EXTRACTED STRINGS ---

**Your Task:**
Analyze the provided Hex Dump and Extracted Strings to generate a detailed BSOD analysis report in JSON format. The analysis must be authentic and highly technical, but the final recommendations must be clear for a power user. Identify potential bug check codes and failing modules (like .sys files) from the data to inform your analysis. **Crucially, reconstruct the stack trace by finding function call patterns within the extracted strings; do not invent a generic one.**
`;
            const report = await generateInitialAnalysis(dumpFile.file.name, prompt);
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
HEX DUMP (first 1024 bytes):
${hexDump}

EXTRACTED STRINGS (first 25000 chars):
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
    const MAX_STRINGS_LENGTH = 25000;
    const extractedStrings = extractPrintableStrings(fileBuffer).substring(0, MAX_STRINGS_LENGTH);
    const hexDump = generateHexDump(fileBuffer, 1024);

    const prompt = getAdvancedPrompt(tool, dumpFile, extractedStrings, hexDump);
    try {
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: {
                // Lower temperature for more deterministic, "console-like" output
                temperature: 0.1,
            }
        });
        return response.text;
    } catch (error) {
         console.error(`Error running advanced analysis for ${dumpFile.file.name} with tool ${tool}:`, error);
        throw new Error(`Failed to run advanced analysis tool ${tool}.`);
    }
};