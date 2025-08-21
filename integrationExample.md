# BSOD Analyzer Integration Guide

## The Problem

The current BSOD analyzer is extracting bug check codes from the wrong offset in PAGEDU64 dumps, causing:
- Incorrect bug check codes (e.g., showing 0x65F4 instead of the real 0x0A)
- AI hallucination of fake drivers like "wXr.sys"
- Completely wrong analysis that doesn't match WinDbg

## The Solution

### 1. Update the Bug Check Extraction in `dumpParser.ts`

Replace the incorrect offset (0x80) with the correct offset (0x38) for PAGEDU64 dumps:

```typescript
// In utils/dumpParser.ts, around line 962-974
// CURRENT (WRONG):
if (sig1 === 0x45474150 && sig2 === 0x34365544) { // 'PAGE' 'DU64'
    // In full dumps, bug check is at offset 0x80 ❌ WRONG!
    try {
        const code = view.getUint32(0x80, true);

// CORRECTED:
if (sig1 === 0x45474150 && sig2 === 0x34365544) { // 'PAGE' 'DU64'
    // In PAGEDU64 dumps, bug check is at offset 0x38 ✅ CORRECT!
    try {
        const code = view.getUint32(0x38, true);
        // Parameters are at 0x40, 0x48, 0x50, 0x58 (8 bytes each)
        const p1 = view.getBigUint64(0x40, true);
        const p2 = view.getBigUint64(0x48, true);
        const p3 = view.getBigUint64(0x50, true);
        const p4 = view.getBigUint64(0x58, true);
```

### 2. Update the Gemini Proxy to Prevent Hallucinations

In `services/geminiProxy.ts`, update the prompt generation to be more strict:

```typescript
// Add strict instructions to prevent hallucination
const strictPrompt = `
CRITICAL RULES - YOU MUST FOLLOW THESE:
1. Use ONLY the bug check code provided: 0x${bugCheckCode.toString(16).toUpperCase()}
2. Use ONLY module names found in the dump - DO NOT invent drivers
3. If you see "wXr.sys" or similar suspicious names, ignore them
4. Base your analysis on Microsoft documentation for the specific bug check
5. DO NOT make up bug check codes like 0x65F4 that don't exist

Bug Check: ${bugCheckName} (0x${bugCheckCode.toString(16).toUpperCase()})
Parameters: ${params.map(p => '0x' + p.toString(16)).join(', ')}
Detected Modules: ${realModules.join(', ')}
`;
```

### 3. Add Validation to Filter Fake Drivers

Create a validation function to filter out AI-generated fake drivers:

```typescript
function isLegitimateDriver(name: string): boolean {
    // Known fake drivers that AI tends to hallucinate
    const fakeDrivers = ['wxr.sys', 'web.sys', 'vs.sys', 'xxx.sys'];
    if (fakeDrivers.includes(name.toLowerCase())) return false;
    
    // Must match Windows driver naming patterns
    if (!/^[a-zA-Z0-9_\-]+\.(sys|dll|exe)$/i.test(name)) return false;
    
    // Must be reasonable length
    if (name.length < 4 || name.length > 64) return false;
    
    return true;
}
```

### 4. Implement the Professional Parser

Replace the flawed extraction with the professional parser approach:

```typescript
import { analyzeDumpComprehensive } from './utils/professionalDumpParser';

// In your analysis flow:
const crashData = analyzeDumpComprehensive(buffer);
if (crashData) {
    // Use real extracted data, not AI guesses
    const analysis = {
        bugCheckCode: crashData.bugCheckCode,
        bugCheckName: crashData.bugCheckName,
        parameters: crashData.bugCheckParameters,
        drivers: crashData.loadedDrivers.filter(isLegitimateDriver),
        // ... rest of analysis based on actual data
    };
}
```

## Testing the Fix

Use the test script to verify accuracy:

```javascript
// testAccuracy.js
import { extractBugCheckInfo } from './utils/dumpParser.js';

const testDump = '/tmp/052525-9906-01.dmp';
const buffer = fs.readFileSync(testDump);

// Old parser (wrong):
// Bug check: 0x65F4 (fake!)
// Driver: wXr.sys (fake!)

// New parser (correct):
// Bug check: 0x0A (IRQL_NOT_LESS_OR_EQUAL)
// Real drivers from dump

const bugCheck = extractBugCheckInfo(buffer.buffer);
console.log('Extracted:', bugCheck);
// Should show 0x0A, not 0x65F4
```

## Expected Results After Integration

### Before (Current Analyzer):
```
Bug Check: UNKNOWN_BUG_CHECK_0x65F4
Culprit: wXr.sys (does not exist)
Analysis: [Hallucinated content about fake driver]
```

### After (Fixed Analyzer):
```
Bug Check: IRQL_NOT_LESS_OR_EQUAL (0x0000000A)
Parameters: Actual values from dump
Modules: Real drivers found in dump
Analysis: Based on Microsoft documentation for 0x0A
```

## Key Offsets for PAGEDU64 Format

Based on Windows DDK headers and reverse engineering:

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 0x00 | 8 | Signature | "PAGEDU64" |
| 0x08 | 4 | ValidDump | "DUMP" |
| 0x0C | 4 | MajorVersion | Windows major |
| 0x10 | 4 | MinorVersion | Windows minor |
| 0x30 | 4 | MachineImageType | 0x8664 for x64 |
| 0x34 | 4 | NumberProcessors | CPU count |
| **0x38** | **4** | **BugCheckCode** | **Stop code (NOT 0x80!)** |
| 0x40 | 8 | BugCheckParameter1 | First parameter |
| 0x48 | 8 | BugCheckParameter2 | Second parameter |
| 0x50 | 8 | BugCheckParameter3 | Third parameter |
| 0x58 | 8 | BugCheckParameter4 | Fourth parameter |

## Deployment Steps

1. **Update `dumpParser.ts`** with correct offsets
2. **Update `geminiProxy.ts`** with strict prompt rules
3. **Add driver validation** to filter fake names
4. **Test with real dumps** to verify accuracy
5. **Deploy and monitor** for improved results

## Monitoring Success

After deployment, you should see:
- Bug check codes matching WinDbg output
- Real driver names from the dumps
- No more "wXr.sys" or "0x65F4" hallucinations
- Analysis that matches Microsoft documentation

## Additional Improvements

Consider adding:
1. **Checksum validation** for dump integrity
2. **Symbol resolution** for better stack traces
3. **Pattern matching** for common crash scenarios
4. **Caching** of analysis results
5. **Comparison mode** with WinDbg output