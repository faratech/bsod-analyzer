# BSOD Analyzer Security Measures

This document outlines the comprehensive security measures implemented to prevent abuse and ensure safe operation of the BSOD Analyzer application.

## Client-Side Security

### 1. File Size Validation
- **Minimum size**: 56KB (prevents fake/empty dumps - real minidumps are typically at least this size)
- **Maximum size**: 100MB per file
- **Location**: `utils/fileValidation.ts`, `components/FileUploader.tsx`

### 2. File Type Validation
- **Allowed extensions**: `.dmp`, `.zip` only
- **Magic number validation**: Verifies actual file format using file headers
  - MDMP (0x4D444D50) for Windows minidumps
  - PAGE (0x50414745) for kernel dumps
  - PK.. (0x504B) for ZIP files
- **Location**: `utils/fileValidation.ts`

### 3. File Count Limits
- **Maximum files**: 10 files per upload session
- **Concurrent processing**: Maximum 5 files processed simultaneously
- **Location**: `config/security.ts`, `components/FileUploader.tsx`

### 4. ZIP File Security
- **Maximum extracted size**: 200MB (prevents zip bombs)
- **Maximum files in ZIP**: 20 files
- **Maximum compression ratio**: 100:1 (detects suspicious compression)
- **Maximum directory depth**: 2 levels
- **Only .dmp files allowed inside ZIPs**
- **Location**: `utils/zipSecurity.ts`

### 5. Content Sanitization
- **String extraction**: Limited to 25,000 characters
- **Hex dump**: Limited to 1024 bytes
- **Removes control characters and potential script injections**
- **Processing timeout**: 30 seconds per file
- **Location**: `utils/contentSanitizer.ts`

## Server-Side Security

### 1. Rate Limiting
- **Window**: 15 minutes
- **Maximum requests**: 100 per IP address per window
- **Applied to**: All `/api/` endpoints
- **Location**: `server.js`

### 2. Request Size Validation
- **Maximum request size**: 10MB
- **Validates before processing**
- **Location**: `server.js`

### 3. Path Blocking
- **Blocked directories**: `/public`, `/src`, `/components`, `/pages`, `/services`, `/hooks`, `/types`, `/node_modules`, `/.git`, `/.env`
- **Blocked file types**: `.ts`, `.tsx`, `.js.map`, `.css.map`, `.log`, `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `.env`
- **Location**: `server.js`

### 4. Security Headers
- **X-Content-Type-Options**: nosniff
- **X-Frame-Options**: DENY
- **X-XSS-Protection**: 1; mode=block
- **Location**: `server.js`

## API Security

### 1. API Key Protection
- **Development**: Uses `.env.local` file (never committed)
- **Production**: Google Secret Manager
- **Backend proxy**: API key never exposed to client
- **Location**: `server.js`, `services/geminiProxy.ts`

### 2. Input Validation
- **All user inputs sanitized before API calls**
- **File content processed client-side before transmission**
- **No direct file uploads to server**

## Error Handling

### 1. User-Friendly Error Messages
- **Validation errors shown for 5 seconds**
- **Clear instructions on file requirements**
- **No sensitive information in error messages**

### 2. Graceful Degradation
- **Timeouts prevent infinite processing**
- **Partial results returned when possible**
- **Clear error states in UI**

## Configuration

All security limits are centralized in:
- **Client**: `/config/security.ts`
- **Server**: `/serverConfig.js`

This allows easy adjustment of limits based on usage patterns and security requirements.

## Future Considerations

1. **CAPTCHA**: For repeated failed attempts
2. **User Authentication**: For premium features
3. **File Scanning**: Integration with antivirus APIs
4. **Audit Logging**: Track usage patterns for anomaly detection
5. **CDN/WAF**: Additional protection layer for production