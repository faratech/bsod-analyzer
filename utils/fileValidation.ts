import { SECURITY_CONFIG } from '../config/security';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateFileSize(file: File): ValidationResult {
  if (file.size < SECURITY_CONFIG.file.minSize) {
    return {
      valid: false,
      error: `File "${file.name}" is too small. Minimum size is ${formatBytes(SECURITY_CONFIG.file.minSize)}.`
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
  const extension = '.' + file.name.split('.').pop()?.toLowerCase();
  
  if (!SECURITY_CONFIG.file.allowedExtensions.includes(extension)) {
    return {
      valid: false,
      error: `File type "${extension}" is not allowed. Only ${SECURITY_CONFIG.file.allowedExtensions.join(', ')} files are accepted.`
    };
  }
  
  return { valid: true };
}

export async function validateFileMagicBytes(file: File): Promise<ValidationResult> {
  const extension = '.' + file.name.split('.').pop()?.toLowerCase();
  let magicBytesConfig;
  switch (extension) {
    case '.zip':
      magicBytesConfig = SECURITY_CONFIG.validation.zipMagicBytes;
      break;
    case '.7z':
      magicBytesConfig = SECURITY_CONFIG.validation.sevenZipMagicBytes;
      break;
    case '.rar':
      magicBytesConfig = SECURITY_CONFIG.validation.rarMagicBytes;
      break;
    default:
      magicBytesConfig = SECURITY_CONFIG.validation.dmpMagicBytes;
      break;
  }
  
  try {
    const headerBytes = await readFileHeader(file, 8);
    
    const isValidMagic = magicBytesConfig.some(config => {
      return config.bytes.every((byte, index) => 
        headerBytes[config.offset + index] === byte
      );
    });
    
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

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
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