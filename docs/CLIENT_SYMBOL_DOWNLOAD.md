# Client-Side Symbol Download

## Overview

The BSOD Analyzer now downloads symbol files directly in the browser, providing enhanced stack trace resolution without any server-side storage or persistence requirements.

## How It Works

1. **On-Demand Downloads**: When analyzing a dump file, the system identifies which modules need symbols
2. **CDN Fetching**: Symbol files are downloaded from public CDN sources (GitHub, jsDelivr)
3. **Memory-Only Storage**: Downloaded symbols are kept in browser memory only
4. **No Persistence**: Symbols are re-downloaded each session (keeps Cloud Run stateless)

## Implementation

### Symbol Sources

Symbols are hosted as static JSON files on GitHub:
```
https://raw.githubusercontent.com/faratech/bsod-symbols/main/
├── ntoskrnl.exe.json
├── hal.dll.json
├── win32k.sys.json
├── ndis.sys.json
└── tcpip.sys.json
```

### Usage Example

```typescript
// Automatic download during analysis
const resolver = new SymbolResolver();
const symbol = await resolver.resolveAsync(0xfffff80012345678);
// Downloads ntoskrnl.exe.json if needed, then returns:
// "ntoskrnl.exe!KeBugCheckEx+0x678"

// Manual download with progress
const downloader = new ClientSymbolDownloader();
await downloader.downloadModuleSymbols('ntoskrnl.exe');
const stats = downloader.getStats();
// { downloadedModules: 1, totalSymbols: 108, ... }
```

### Stack Trace Enhancement

**Before (no symbols):**
```
00: 0xfffff80012345678
01: 0xfffff80023456789
02: 0xfffff88012345678
```

**After (with downloaded symbols):**
```
00: ntoskrnl.exe!KeBugCheckEx+0x678
01: ntoskrnl.exe!KiPageFault+0x234  
02: somedriver.sys+0x5678
```

## Benefits

1. **No Server Storage**: Perfect for stateless Cloud Run
2. **Privacy**: No data sent to servers
3. **Fast**: CDN delivery with browser caching
4. **Transparent**: Users see download progress
5. **Free**: Uses free CDN hosting

## Creating Symbol Files

### From Public Sources

1. **Windows SDK/WDK**: Export public symbols
2. **Microsoft Symbol Server**: Download and convert PDBs
3. **Open Source**: Extract from debug builds

### Format

Simple JSON mapping of RVA to function name:
```json
{
  "0x1000": "KeBugCheckEx",
  "0x1200": "KeBugCheck",
  "0x2000": "KiSystemServiceCopyEnd"
}
```

### Building Symbol Database

```bash
# Script to generate symbol files
node scripts/build-symbols.js

# Generates:
# - Downloads PDBs from Microsoft Symbol Server
# - Extracts public symbols only
# - Converts to JSON format
# - Compresses for CDN hosting
```

## Performance

- **Initial Download**: ~50KB per module (compressed)
- **Cache**: Browser caches for session
- **Memory**: ~1MB for typical analysis
- **Speed**: <500ms per module on fast connection

## Future Enhancements

1. **IndexedDB Cache**: Optional persistent caching
2. **Compression**: Brotli compression for smaller downloads
3. **Incremental Updates**: Delta downloads for updates
4. **P2P Sharing**: WebRTC symbol sharing between users
5. **WASM Decompression**: Client-side PDB parsing

## Privacy & Security

- **No Upload**: Symbols never leave the browser
- **Public Only**: Only public symbols included
- **No Tracking**: No analytics on symbol usage
- **Open Source**: Symbol database is public

## Limitations

1. **Coverage**: Only common Windows modules
2. **Versions**: Generic symbols (not version-specific)
3. **Size**: Limited by browser memory
4. **Network**: Requires internet for first download

## Contributing Symbols

Help improve the symbol database:

1. Fork: https://github.com/faratech/bsod-symbols
2. Add symbols following the format
3. Submit PR with source attribution
4. Must be legally obtained public symbols

## Example Integration

```tsx
// In your React component
const AnalyzerWithSymbols = () => {
    const { resolve, stats } = useSymbolResolver();
    const [stackTrace, setStackTrace] = useState([]);
    
    const analyzeWithSymbols = async (dump) => {
        // Extract raw addresses
        const addresses = extractAddresses(dump);
        
        // Resolve with automatic download
        const resolved = await Promise.all(
            addresses.map(addr => resolve(addr.module, addr.base, addr.address))
        );
        
        setStackTrace(resolved);
    };
    
    return (
        <div>
            <SymbolDownloadProgress stats={stats} />
            <StackTraceDisplay trace={stackTrace} />
        </div>
    );
};
```