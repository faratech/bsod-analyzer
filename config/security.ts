export const SECURITY_CONFIG = {
  file: {
    minSize: 56 * 1024, // 56KB minimum - realistic size for legitimate dump files
    maxSize: 100 * 1024 * 1024, // 100MB maximum
    maxFileCount: 10, // Maximum files per upload session
    allowedExtensions: ['.dmp', '.zip'],
    allowedMimeTypes: [
      'application/octet-stream',
      'application/x-dmp',
      'application/zip',
      'application/x-zip-compressed',
      'application/x-zip'
    ]
  },
  
  zip: {
    maxExtractedSize: 200 * 1024 * 1024, // 200MB max after extraction
    maxFileCount: 20, // Maximum files in a zip
    maxCompressionRatio: 100, // Reject if extracted size > compressed size * ratio
    maxDepth: 2 // Maximum directory depth in zip
  },
  
  processing: {
    maxStringLength: 25000, // Maximum characters to extract from dump
    maxHexDumpSize: 1024, // Maximum bytes for hex dump
    maxConcurrentFiles: 5, // Maximum files processed simultaneously
    processingTimeout: 30000 // 30 seconds timeout per file
  },
  
  api: {
    maxRequestSize: 10 * 1024 * 1024, // 10MB max request to backend
    rateLimiting: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      maxRequests: 100, // Limit each IP to 100 requests per windowMs
      message: 'Too many requests from this IP, please try again later'
    },
    maxConcurrentRequests: 3 // Per client
  },
  
  validation: {
    dmpMagicBytes: [
      { bytes: [0x4D, 0x44, 0x4D, 0x50], offset: 0 }, // MDMP - Windows minidump
      { bytes: [0x50, 0x41, 0x47, 0x45], offset: 0 }, // PAGE - Kernel dump
    ],
    zipMagicBytes: [
      { bytes: [0x50, 0x4B, 0x03, 0x04], offset: 0 }, // PK.. - Standard ZIP
      { bytes: [0x50, 0x4B, 0x05, 0x06], offset: 0 }, // PK.. - Empty ZIP
      { bytes: [0x50, 0x4B, 0x07, 0x08], offset: 0 }, // PK.. - Spanned ZIP
    ]
  }
};

export type SecurityConfig = typeof SECURITY_CONFIG;