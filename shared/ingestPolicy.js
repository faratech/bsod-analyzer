const MB = 1024 * 1024;

const DUMP_EXTENSIONS = Object.freeze(['.dmp', '.mdmp', '.hdmp', '.kdmp']);
const ARCHIVE_EXTENSIONS = Object.freeze(['.zip', '.7z', '.rar']);
const ALLOWED_EXTENSIONS = Object.freeze([...DUMP_EXTENSIONS, ...ARCHIVE_EXTENSIONS]);

const FILE_LIMITS = Object.freeze({
  minDumpSize: 56 * 1024,
  minArchiveSize: 16 * 1024,
  maxFileSize: 100 * MB,
  maxFileCount: 10,
  maxArchiveFileCount: 20,
  maxArchiveExtractedSize: 100 * MB,
  maxPathDepth: 4,
  maxCompressionRatio: 100,
  maxDumpFileSizeInArchive: 100 * MB
});

const API_LIMITS = Object.freeze({
  maxRequestSize: 10 * MB,
  maxUploadRequestSize: 150 * MB,
  maxRawFileSize: FILE_LIMITS.maxFileSize,
  maxExtractedArchiveSize: FILE_LIMITS.maxArchiveExtractedSize,
  rateLimiting: Object.freeze({
    windowMs: 15 * 60 * 1000,
    maxRequests: 100,
    message: 'Too many requests from this IP, please try again later'
  }),
  maxConcurrentRequests: 3
});

const MAGIC_SIGNATURES = Object.freeze({
  dump: Object.freeze({
    mdmp: Object.freeze([0x4D, 0x44, 0x4D, 0x50]),
    page: Object.freeze([0x50, 0x41, 0x47, 0x45]),
    pageDump: Object.freeze([0x50, 0x41, 0x47, 0x45, 0x44, 0x55, 0x4D, 0x50]),
    pageDump64: Object.freeze([0x50, 0x41, 0x47, 0x45, 0x44, 0x55, 0x36, 0x34])
  }),
  archiveSignatures: Object.freeze([
    Object.freeze({ type: 'zip', bytes: Object.freeze([0x50, 0x4B, 0x03, 0x04]) }),
    Object.freeze({ type: 'zip', bytes: Object.freeze([0x50, 0x4B, 0x05, 0x06]) }),
    Object.freeze({ type: 'zip', bytes: Object.freeze([0x50, 0x4B, 0x07, 0x08]) }),
    Object.freeze({ type: '7z', bytes: Object.freeze([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]) }),
    Object.freeze({ type: 'rar', bytes: Object.freeze([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x01, 0x00]) }),
    Object.freeze({ type: 'rar', bytes: Object.freeze([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00]) })
  ]),
  fileValidation: Object.freeze({
    dmpMagic: Object.freeze([
      Object.freeze({ bytes: Object.freeze([0x4D, 0x44, 0x4D, 0x50]), offset: 0 }),
      Object.freeze({ bytes: Object.freeze([0x50, 0x41, 0x47, 0x45]), offset: 0 })
    ]),
    sevenZipMagic: Object.freeze([
      Object.freeze({ bytes: Object.freeze([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]), offset: 0 })
    ]),
    rarMagic: Object.freeze([
      Object.freeze({ bytes: Object.freeze([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x01, 0x00]), offset: 0 }),
      Object.freeze({ bytes: Object.freeze([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00]), offset: 0 })
    ]),
    zipMagic: Object.freeze([
      Object.freeze({ bytes: Object.freeze([0x50, 0x4B, 0x03, 0x04]), offset: 0 }),
      Object.freeze({ bytes: Object.freeze([0x50, 0x4B, 0x05, 0x06]), offset: 0 }),
      Object.freeze({ bytes: Object.freeze([0x50, 0x4B, 0x07, 0x08]), offset: 0 })
    ])
  })
});

const SECURITY = Object.freeze({
  file: Object.freeze({
    minSize: FILE_LIMITS.minDumpSize,
    archiveMinSize: FILE_LIMITS.minArchiveSize,
    maxSize: FILE_LIMITS.maxFileSize,
    maxFileCount: FILE_LIMITS.maxFileCount,
    allowedExtensions: ALLOWED_EXTENSIONS,
    allowedMimeTypes: Object.freeze([
      'application/octet-stream',
      'application/x-dmp',
      'application/zip',
      'application/x-zip-compressed',
      'application/x-zip',
      'application/x-7z-compressed',
      'application/x-rar-compressed',
      'application/vnd.rar'
    ])
  }),
  zip: Object.freeze({
    maxExtractedSize: FILE_LIMITS.maxArchiveExtractedSize,
    maxFileCount: FILE_LIMITS.maxArchiveFileCount,
    maxCompressionRatio: FILE_LIMITS.maxCompressionRatio,
    maxDepth: FILE_LIMITS.maxPathDepth
  })
});

function getFileExtension(fileName) {
  return String(fileName || '').trim().toLowerCase().match(/\.[^.\\/]+$/)?.[0] || '';
}

function sanitizeUploadFileName(fileName) {
  const base = String(fileName || 'upload.dmp').split(/[\\/]/).pop() || 'upload.dmp';
  const cleaned = base
    .replace(/[\0\r\n"]+/g, '_')
    .replace(/[^\w.\-() ]+/g, '_')
    .trim();
  return cleaned || 'upload.dmp';
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function startsWithMagic(buffer, bytes, offset = 0) {
  if (!buffer || buffer.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => buffer[offset + index] === byte);
}

function hasAnyMagic(buffer, config) {
  if (!buffer || typeof buffer.length !== 'number' || !Array.isArray(config)) return false;
  return config.some(({ bytes, offset = 0 }) => startsWithMagic(buffer, bytes, offset));
}

function detectArchiveType(fileBuffer) {
  if (!fileBuffer || typeof fileBuffer.length !== 'number') return null;
  for (const { type, bytes } of MAGIC_SIGNATURES.archiveSignatures) {
    if (startsWithMagic(fileBuffer, bytes)) return type;
  }
  return null;
}

function looksLikeDump(buffer) {
  if (!buffer || typeof buffer.slice !== 'function') return false;
  const header = Array.from(buffer.slice(0, 8), byte => String.fromCharCode(byte)).join('');
  return header.startsWith('MDMP') ||
    header.startsWith('PAGEDU64') ||
    header.startsWith('PAGEDUMP') ||
    header.startsWith('PAGE');
}

function validatePathEntry(entryPath, maxDepth = FILE_LIMITS.maxPathDepth) {
  const normalized = String(entryPath || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) return false;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some(part => part === '..' || part === '.')) return false;
  return parts.length <= maxDepth;
}

function isDumpFileName(fileName) {
  return DUMP_EXTENSIONS.includes(getFileExtension(fileName));
}

function isArchiveFileName(fileName) {
  return ARCHIVE_EXTENSIONS.includes(getFileExtension(fileName));
}

function validateUploadedBuffer(fileBuffer, fileName, { allowArchives = true } = {}) {
  if (!fileBuffer || typeof fileBuffer.length !== 'number' || fileBuffer.length === 0) {
    return { valid: false, error: 'File is empty or invalid' };
  }

  if (fileBuffer.length > FILE_LIMITS.maxFileSize) {
    return {
      valid: false,
      error: `File is too large. Maximum size is ${(FILE_LIMITS.maxFileSize / 1024 / 1024).toFixed(0)}MB`
    };
  }

  const ext = getFileExtension(fileName);
  if (DUMP_EXTENSIONS.includes(ext)) {
    if (fileBuffer.length < FILE_LIMITS.minDumpSize) {
      return {
        valid: false,
        error: `Dump file is too small. Minimum size is ${formatBytes(FILE_LIMITS.minDumpSize)}`
      };
    }
    if (!looksLikeDump(fileBuffer)) {
      return { valid: false, error: 'File does not appear to be a valid Windows dump' };
    }
    return { valid: true, archiveType: null };
  }

  if (allowArchives && ARCHIVE_EXTENSIONS.includes(ext)) {
    if (fileBuffer.length < FILE_LIMITS.minArchiveSize) {
      return {
        valid: false,
        error: `Archive file is too small. Minimum size is ${formatBytes(FILE_LIMITS.minArchiveSize)}`
      };
    }
    const archiveType = detectArchiveType(fileBuffer);
    if (!archiveType) {
      return { valid: false, error: 'Archive extension does not match archive signature' };
    }
    if (archiveType !== ext.slice(1)) {
      return { valid: false, error: 'Archive extension does not match archive signature' };
    }
    return { valid: true, archiveType };
  }

  return { valid: false, error: 'Unsupported file type' };
}

export {
  DUMP_EXTENSIONS,
  ARCHIVE_EXTENSIONS,
  ALLOWED_EXTENSIONS,
  FILE_LIMITS,
  API_LIMITS,
  SECURITY,
  MAGIC_SIGNATURES,
  getFileExtension,
  sanitizeUploadFileName,
  formatBytes,
  startsWithMagic,
  hasAnyMagic,
  detectArchiveType,
  looksLikeDump,
  validatePathEntry,
  isDumpFileName,
  isArchiveFileName,
  validateUploadedBuffer
};
