// Test script to verify dump parsing accuracy
// Run this against the test dumps to ensure correct extraction

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Test data from WinDbg analysis
const expectedResults = {
    '071325-19281-01.dmp': {
        bugCheck: 0xF5,
        bugCheckName: 'FLTMGR_FILE_SYSTEM',
        culprit: 'bindflt.sys',
        process: 'CompatTelRunne'
    },
    '052525-9906-01.dmp': {
        bugCheck: 0xA,
        bugCheckName: 'IRQL_NOT_LESS_OR_EQUAL',
        culprit: 'nt!KiExecuteAllDpcs',
        process: 'System'
    }
};

async function testDumpFile(dumpPath, expected) {
    console.log(`\nTesting ${path.basename(dumpPath)}...`);
    
    const buffer = fs.readFileSync(dumpPath);
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    const view = new DataView(arrayBuffer);
    
    // Check signature
    const sig = view.getUint32(0, true);
    console.log(`Signature: 0x${sig.toString(16).padStart(8, '0')}`);
    
    // For minidumps
    if (sig === 0x504D444D) { // 'MDMP'
        console.log('File type: Minidump');
        
        // Parse minidump header
        const version = view.getUint32(4, true);
        const streamCount = view.getUint32(8, true);
        const streamDirRva = view.getUint32(12, true);
        
        console.log(`Version: ${version}`);
        console.log(`Stream count: ${streamCount}`);
        console.log(`Stream directory RVA: 0x${streamDirRva.toString(16)}`);
        
        // Look for exception stream
        for (let i = 0; i < streamCount; i++) {
            const streamOffset = streamDirRva + (i * 12);
            if (streamOffset + 12 > arrayBuffer.byteLength) break;
            
            const streamType = view.getUint32(streamOffset, true);
            const dataSize = view.getUint32(streamOffset + 4, true);
            const rva = view.getUint32(streamOffset + 8, true);
            
            if (streamType === 6) { // Exception stream
                console.log(`\nFound exception stream at RVA 0x${rva.toString(16)}`);
                
                if (rva + 168 <= arrayBuffer.byteLength) {
                    // Parse exception
                    const exceptionCode = view.getUint32(rva + 8, true);
                    console.log(`Exception code: 0x${exceptionCode.toString(16).padStart(8, '0')}`);
                    
                    if (exceptionCode === 0x80000003) {
                        // Bug check info in exception parameters
                        const bugCheck = view.getUint32(rva + 40, true);
                        console.log(`Bug check code: 0x${bugCheck.toString(16).padStart(8, '0')}`);
                        
                        if (bugCheck === expected.bugCheck) {
                            console.log('✓ Bug check matches expected!');
                        } else {
                            console.log(`✗ Bug check mismatch! Expected 0x${expected.bugCheck.toString(16)}`);
                        }
                    }
                }
            }
        }
    }
    
    // For kernel dumps
    else if (sig === 0x45474150) { // 'PAGE'
        const sig2 = view.getUint32(4, true);
        if (sig2 === 0x34365544 || sig2 === 0x504D5544) { // 'DU64' or 'DUMP'
            console.log('File type: Kernel dump');
            
            // Bug check at offset 0x40 for PAGEDU64
            if (arrayBuffer.byteLength >= 0x68) {
                const bugCheck = view.getUint32(0x40, true);
                console.log(`Bug check code: 0x${bugCheck.toString(16).padStart(8, '0')}`);
                
                const param1 = view.getBigUint64(0x48, true);
                const param2 = view.getBigUint64(0x50, true);
                const param3 = view.getBigUint64(0x58, true);
                const param4 = view.getBigUint64(0x60, true);
                
                console.log(`Parameters: ${param1.toString(16)}, ${param2.toString(16)}, ${param3.toString(16)}, ${param4.toString(16)}`);
            }
        }
    }
}

// Run tests
async function runTests() {
    const testFiles = [
        '/tmp/071325-19281-01.dmp',
        '/tmp/052525-9906-01.dmp',
        '/tmp/052625-11968-01.dmp'
    ];
    
    for (const file of testFiles) {
        if (fs.existsSync(file)) {
            const basename = path.basename(file);
            const expected = expectedResults[basename] || {};
            await testDumpFile(file, expected);
        } else {
            console.log(`\nSkipping ${file} - not found`);
        }
    }
}

runTests().catch(console.error);