#!/usr/bin/env node

import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// We'll inline the extractPrintableStrings function since it's not exported
function extractPrintableStrings(buffer, minLength = 4) {
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
    
    return result;
}

// Import the other functions
import { getStructuredDumpInfo } from './utils/dumpParser.js';
import { MinidumpParser } from './utils/minidumpStreams.js';
import { executeAnalyzeV, executeLmKv } from './utils/windbgCommands.js';
import { analyzeMemoryPatterns } from './utils/memoryPatternAnalyzer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Test data - create a minimal minidump structure for testing
function createTestMinidump() {
    // Minimal MINIDUMP structure
    const buffer = new ArrayBuffer(0x1000);
    const view = new DataView(buffer);
    
    // MINIDUMP_HEADER
    view.setUint32(0, 0x504D444D, true); // Signature 'MDMP'
    view.setUint32(4, 0x0000A793, true); // Version
    view.setUint32(8, 3, true); // NumberOfStreams
    view.setUint32(12, 0x20, true); // StreamDirectoryRva
    view.setUint32(16, 0, true); // CheckSum
    view.setUint32(20, Date.now() / 1000, true); // TimeDateStamp
    view.setBigUint64(24, 0n, true); // Flags
    
    // Stream directory entries
    let streamOffset = 0x20;
    let dataOffset = 0x100;
    
    // SystemInfoStream
    view.setUint32(streamOffset, 7, true); // StreamType
    view.setUint32(streamOffset + 4, 56, true); // DataSize
    view.setUint32(streamOffset + 8, dataOffset, true); // Rva
    
    // Fill SystemInfo
    view.setUint16(dataOffset, 0x8664, true); // ProcessorArchitecture (AMD64)
    view.setUint16(dataOffset + 2, 6, true); // ProcessorLevel
    view.setUint16(dataOffset + 4, 0x3F00, true); // ProcessorRevision
    view.setUint8(dataOffset + 6, 8); // NumberOfProcessors
    view.setUint8(dataOffset + 7, 1); // ProductType
    view.setUint32(dataOffset + 8, 10, true); // MajorVersion
    view.setUint32(dataOffset + 12, 0, true); // MinorVersion
    view.setUint32(dataOffset + 16, 19041, true); // BuildNumber
    
    // Add some test strings
    const testStrings = new TextEncoder().encode(
        'ntoskrnl.exe\0' +
        'nt!KeBugCheckEx\0' +
        'nt!KiPageFault+0x260\0' +
        'hal!HalProcessorIdle+0x9\0' +
        'nvlddmkm.sys\0' +
        'DRIVER_IRQL_NOT_LESS_OR_EQUAL\0' +
        'BugCheck D1, {fffff802345678, 2, 0, fffff80234567890}\0'
    );
    
    const stringOffset = 0x200;
    new Uint8Array(buffer, stringOffset, testStrings.length).set(testStrings);
    
    return buffer;
}

async function testExtractionPipeline() {
    console.log('=== Testing BSOD Analyzer Extraction Pipeline ===\n');
    
    const testBuffer = createTestMinidump();
    
    // Test 1: Basic string extraction
    console.log('1. Testing String Extraction:');
    console.log('----------------------------');
    const strings = extractPrintableStrings(testBuffer);
    console.log('Extracted strings length:', strings.length);
    console.log('Sample strings:', strings.slice(0, 200));
    console.log();
    
    // Test 2: Structured dump info
    console.log('2. Testing Structured Dump Info:');
    console.log('--------------------------------');
    const structuredInfo = getStructuredDumpInfo(testBuffer, strings);
    console.log('Dump Header:', structuredInfo.dumpHeader);
    console.log('Bug Check Info:', structuredInfo.bugCheckInfo);
    console.log('Module List:', structuredInfo.moduleList);
    console.log();
    
    // Test 3: WinDbg Commands
    console.log('3. Testing WinDbg Commands:');
    console.log('---------------------------');
    const analyzeResult = executeAnalyzeV(testBuffer);
    console.log('!analyze -v success:', analyzeResult.success);
    if (analyzeResult.success) {
        console.log('Output preview:', analyzeResult.output.slice(0, 300) + '...');
    } else {
        console.log('Error:', analyzeResult.error);
    }
    console.log();
    
    const lmResult = executeLmKv(testBuffer);
    console.log('lm kv success:', lmResult.success);
    if (lmResult.success) {
        console.log('Output preview:', lmResult.output.slice(0, 300) + '...');
    }
    console.log();
    
    // Test 4: Memory Pattern Analysis
    console.log('4. Testing Memory Pattern Analysis:');
    console.log('-----------------------------------');
    try {
        const memoryAnalysis = analyzeMemoryPatterns(testBuffer);
        console.log('Summary:', memoryAnalysis.summary);
        console.log('Corruption indicators:', memoryAnalysis.corruption.length);
        console.log('Suspicious patterns:', memoryAnalysis.patterns.length);
        if (memoryAnalysis.corruption.length > 0) {
            console.log('First corruption:', memoryAnalysis.corruption[0]);
        }
    } catch (error) {
        console.log('Memory analysis error:', error.message);
    }
    console.log();
    
    // Test 5: MinidumpParser
    console.log('5. Testing MinidumpParser:');
    console.log('--------------------------');
    try {
        const parser = new MinidumpParser(testBuffer);
        const systemInfo = parser.getSystemInfo();
        console.log('System Info:', systemInfo);
        
        const threads = parser.getThreads();
        console.log('Thread count:', threads.length);
        
        const modules = parser.getModules();
        console.log('Module count:', modules.length);
    } catch (error) {
        console.log('MinidumpParser error:', error.message);
    }
    console.log();
    
    // Test 6: What gets sent to AI
    console.log('6. Information Sent to AI:');
    console.log('--------------------------');
    console.log('The AI receives:');
    console.log('- Bug check code and parameters with detailed explanations');
    console.log('- Extracted stack traces (if found)');
    console.log('- Module list with timestamps');
    console.log('- Memory corruption indicators');
    console.log('- Driver version information');
    console.log('- Raw strings and hex dump for analysis');
    console.log();
    
    // Show sample prompt structure
    console.log('Sample AI Prompt Structure:');
    console.log('---------------------------');
    const samplePrompt = `
## CRASH CONTEXT
**File:** test.dmp (minidump, ${testBuffer.byteLength} bytes)
**Bug Check:** ${structuredInfo.bugCheckInfo ? `0x${structuredInfo.bugCheckInfo.code.toString(16).padStart(8, '0')}` : 'Not found'}

**Structured Dump Analysis:**
${JSON.stringify(structuredInfo, null, 2).slice(0, 500)}...

**Stack Trace (${structuredInfo.moduleList.length} frames extracted):**
${structuredInfo.moduleList.slice(0, 5).map((m, i) => `${i}: ${m.name}`).join('\n')}

**Binary Dump Analysis:**
[First 512 bytes in hex format]

**Extracted String Data:**
${strings.slice(0, 1000)}
`;
    
    console.log(samplePrompt);
}

// Run the test
testExtractionPipeline().catch(console.error);