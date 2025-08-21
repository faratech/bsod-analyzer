// Quick test of accurate dump parsing
import fs from 'fs';

// Known bug check codes (subset for testing)
const BUG_CHECK_CODES = {
    0x0A: 'IRQL_NOT_LESS_OR_EQUAL',
    0x1E: 'KMODE_EXCEPTION_NOT_HANDLED',
    0x50: 'PAGE_FAULT_IN_NONPAGED_AREA',
    0x7E: 'SYSTEM_THREAD_EXCEPTION_NOT_HANDLED',
    0xF5: 'FLTMGR_FILE_SYSTEM'
};

function analyzeDump(filename) {
    console.log(`\n=== Analyzing ${filename} ===`);
    
    try {
        const buffer = fs.readFileSync(filename);
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        
        // Check signature
        const sig = Buffer.from(buffer.slice(0, 8)).toString('ascii');
        console.log('File signature:', sig);
        
        if (sig.startsWith('PAGEDU64')) {
            // For this specific dump format, bug check is at 0x38
            const bugCheckCode = view.getUint32(0x38, true);
            const param1 = view.getUint32(0x40, true);
            const param2 = view.getUint32(0x48, true);
            const param3 = view.getUint32(0x50, true);
            const param4 = view.getUint32(0x58, true);
            
            console.log('\nActual Bug Check (not hallucinated):');
            console.log(`Code: 0x${bugCheckCode.toString(16).toUpperCase().padStart(2, '0')} - ${BUG_CHECK_CODES[bugCheckCode] || 'Unknown'}`);
            console.log('Parameters:');
            console.log(`  Param1: 0x${param1.toString(16).padStart(8, '0')}`);
            console.log(`  Param2: 0x${param2.toString(16).padStart(8, '0')}`);
            console.log(`  Param3: 0x${param3.toString(16).padStart(8, '0')}`);
            console.log(`  Param4: 0x${param4.toString(16).padStart(8, '0')}`);
        }
        
        // Extract real module names (not wXr.sys!)
        const text = buffer.toString('ascii', 0, Math.min(buffer.length, 65536))
            .replace(/[\x00-\x1F\x7F-\xFF]/g, ' ');
        const modulePattern = /([a-zA-Z0-9_\-]+\.(sys|dll|exe))/g;
        const modules = [...new Set(text.match(modulePattern) || [])]
            .filter(m => !['wXr.sys', 'wEB.sys', 'vS.sys'].includes(m));
        
        console.log('\nReal Modules Found:');
        modules.slice(0, 20).forEach(m => console.log(`  - ${m}`));
        
        // Compare with what the AI analyzer shows
        if (sig.startsWith('PAGEDU64')) {
            console.log('\n⚠️  AI Analyzer Issues:');
            console.log('  - Reports: UNKNOWN_BUG_CHECK_0x65F4 (does not exist!)');
            console.log('  - Claims: wXr.sys is the culprit (fake driver!)');
        }
        
    } catch (e) {
        console.error('Error:', e.message);
    }
}

// Test our dumps
const dumpFiles = [
    '/tmp/052525-9906-01.dmp',
    '/tmp/052625-11968-01.dmp'
];

dumpFiles.forEach(file => {
    if (fs.existsSync(file)) {
        analyzeDump(file);
    }
});