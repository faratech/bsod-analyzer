# Symbol Resolution in BSOD Analyzer

## Current Implementation

Current production symbol resolution is primarily provided by WinDBG:
- When the WinDBG path is available, the remote debugger resolves Microsoft symbols and returns professional stack/module output.
- When WinDBG is unavailable, AI fallback reports use validated local or sampled dump evidence. These reports can include module names, strings, and stack-like evidence, but symbol detail may be less complete.
- Static JSON symbol files exist under `public/symbols/` as reference data, but there is no active browser-side `SymbolResolver` implementation wired into the analyzer.

## Enhanced Symbol Resolution Options

### 1. **Symbol Database Approach (Reference Data Present)**
- Pre-built database of common Windows system symbols
- Fast, no external dependencies
- Works offline
- Limited to known symbols
- Not currently wired into the production analyzer flow

**Pros:**
- Fast and reliable
- No network requests needed
- Works in browser environment
- Good coverage for common crash scenarios

**Cons:**
- Limited symbol coverage
- Needs regular updates
- Larger bundle size

### 2. **Microsoft Symbol Server via WinDBG (Production Primary)**
- WinDBG downloads and resolves symbols from Microsoft symbol servers
- Most accurate path for supported dumps
- Requires the WinDBG service and `WINDBG_API_KEY`

**Pros:**
- 100% accurate symbols
- Always up-to-date
- Covers all Microsoft binaries

**Cons:**
- Requires backend implementation
- Slow (downloading PDBs)
- Complex PDB parsing
- Not suitable for client-side

### 3. **Hybrid Approach (Future Option)**
Combine both methods:
1. Use WinDBG symbol output when available
2. Use a local/static symbol database for fallback enrichment
3. Cache results for performance

## Implementation Status

✅ **Completed:**
- WinDBG-backed symbol resolution on the primary analysis path
- Static symbol JSON files for common Windows modules under `public/symbols/`
- AI report generation from WinDBG output

🚧 **Partial:**
- Fallback report enrichment from local or sampled dump evidence

❌ **Not Implemented:**
- Active browser-side symbol resolver wiring
- Full PDB parsing
- Symbol server backend proxy
- Automatic symbol updates

## How Symbols Improve Analysis

**Without symbols:**
```
Stack trace:
00: 0xfffff80012345678
01: 0xfffff80023456789
02: 0xfffff80034567890
```

**With symbols:**
```
Stack trace:
00: ntoskrnl.exe!KeBugCheckEx+0x123
01: ntoskrnl.exe!KiPageFault+0x234
02: mydriver.sys!ProcessBuffer+0x45
```

The AI can now:
- Identify the exact failing function
- Understand the call flow
- Provide specific fixes
- Recognize known problematic functions

## Future Enhancements

1. **CDN-Hosted Symbol Database**
   - Host comprehensive symbol database on CDN
   - Regular updates from Microsoft symbols
   - Compressed format for fast loading

2. **Symbol API Service**
   - Backend service that proxies symbol requests
   - Caches commonly requested symbols
   - Provides symbol resolution as a service

3. **Local Symbol Cache**
   - IndexedDB storage for resolved symbols
   - Persistent across sessions
   - Reduces repeated lookups

## Using Symbol Resolution

Symbol resolution is automatic on the WinDBG-backed path. For fallback reports,
the analyzer extracts bounded local evidence and sends it through the validated
AI proxy. Future work can wire `public/symbols/` into that fallback path if
local symbol enrichment becomes necessary.
