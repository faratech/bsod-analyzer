import { SECURITY_CONFIG } from '../config/security';
import {
  ARCHIVE_EXTENSIONS,
  formatBytes,
  getFileExtension,
  hasAnyMagic,
  MAGIC_SIGNATURES
} from '../shared/ingestPolicy.js';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateFileSize(file: File): ValidationResult {
  const ext = getFileExtension(file.name);
  const isArchive = ARCHIVE_EXTENSIONS.includes(ext);
  const minSize = isArchive ? SECURITY_CONFIG.file.archiveMinSize : SECURITY_CONFIG.file.minSize;

  if (file.size < minSize) {
    return {
      valid: false,
      error: `File "${file.name}" is too small. Minimum size is ${formatBytes(minSize)}.`
    };
  }
  
  if (file.size > SECURITY_CONFIG.file.maxSize) {
    return {
      valid: false,
      error: `File "${file.name}" is too large. Maximum size is ${formatBytes(SECURITY_CONFIG.file.maxSize)}.`
    };
  }
  
  return { valid: true };
}

export function validateFileExtension(file: File): ValidationResult {
  const extension = getFileExtension(file.name);
  
  if (!SECURITY_CONFIG.file.allowedExtensions.includes(extension)) {
    return {
      valid: false,
      error: `File type "${extension}" is not allowed. Only ${SECURITY_CONFIG.file.allowedExtensions.join(', ')} files are accepted.`
    };
  }
  
  return { valid: true };
}

export async function validateFileMagicBytes(file: File): Promise<ValidationResult> {
  const extension = getFileExtension(file.name);
  let magicBytesConfig;
  switch (extension) {
    case '.zip':
      magicBytesConfig = MAGIC_SIGNATURES.fileValidation.zipMagic;
      break;
    case '.7z':
      magicBytesConfig = MAGIC_SIGNATURES.fileValidation.sevenZipMagic;
      break;
    case '.rar':
      magicBytesConfig = MAGIC_SIGNATURES.fileValidation.rarMagic;
      break;
    default:
      magicBytesConfig = MAGIC_SIGNATURES.fileValidation.dmpMagic;
      break;
  }
  
  try {
    const headerBytes = await readFileHeader(file, 8);
    
    const isValidMagic = hasAnyMagic(headerBytes, magicBytesConfig);
    
    if (!isValidMagic) {
      return {
        valid: false,
        error: `File "${file.name}" does not appear to be a valid ${extension} file.`
      };
    }
    
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: `Failed to validate file "${file.name}".`
    };
  }
}

async function readFileHeader(file: File, bytes: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const blob = file.slice(0, bytes);
    
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(new Uint8Array(reader.result));
      } else {
        reject(new Error('Failed to read file header'));
      }
    };
    
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

export function validateFileCount(currentCount: number, newFiles: number): ValidationResult {
  const totalCount = currentCount + newFiles;
  
  if (totalCount > SECURITY_CONFIG.file.maxFileCount) {
    return {
      valid: false,
      error: `Too many files. Maximum ${SECURITY_CONFIG.file.maxFileCount} files allowed per session.`
    };
  }
  
  return { valid: true };
}

export async function validateFiles(files: File[], currentFileCount: number = 0): Promise<{
  validFiles: File[];
  errors: string[];
}> {
  const errors: string[] = [];
  const validFiles: File[] = [];
  
  // Check total file count
  const countValidation = validateFileCount(currentFileCount, files.length);
  if (!countValidation.valid) {
    errors.push(countValidation.error!);
    return { validFiles: [], errors };
  }
  
  // Validate each file
  for (const file of files) {
    // Size validation
    const sizeValidation = validateFileSize(file);
    if (!sizeValidation.valid) {
      errors.push(sizeValidation.error!);
      continue;
    }
    
    // Extension validation
    const extValidation = validateFileExtension(file);
    if (!extValidation.valid) {
      errors.push(extValidation.error!);
      continue;
    }
    
    // Magic bytes validation
    const magicValidation = await validateFileMagicBytes(file);
    if (!magicValidation.valid) {
      errors.push(magicValidation.error!);
      continue;
    }
    
    validFiles.push(file);
  }
  
  return { validFiles, errors };
}
