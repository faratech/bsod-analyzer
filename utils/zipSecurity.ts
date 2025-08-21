import JSZip from 'jszip';
import { SECURITY_CONFIG } from '../config/security';

export interface ZipValidationResult {
  valid: boolean;
  error?: string;
  extractedSize?: number;
  fileCount?: number;
}

export async function validateZipFile(file: File): Promise<ZipValidationResult> {
  try {
    const zip = new JSZip();
    await zip.loadAsync(file);
    
    let totalExtractedSize = 0;
    let fileCount = 0;
    const filePromises: Promise<void>[] = [];
    
    // Check each file in the zip
    zip.forEach((relativePath, zipEntry) => {
      fileCount++;
      
      // Check file count limit
      if (fileCount > SECURITY_CONFIG.zip.maxFileCount) {
        throw new Error(`ZIP contains too many files. Maximum ${SECURITY_CONFIG.zip.maxFileCount} files allowed.`);
      }
      
      // Check directory depth
      const depth = relativePath.split('/').length - 1;
      if (depth > SECURITY_CONFIG.zip.maxDepth) {
        throw new Error(`ZIP contains files nested too deeply. Maximum depth is ${SECURITY_CONFIG.zip.maxDepth}.`);
      }
      
      // Skip directories
      if (zipEntry.dir) {
        return;
      }
      
      // Check file extension
      const fileName = relativePath.split('/').pop() || '';
      if (!fileName.toLowerCase().endsWith('.dmp')) {
        throw new Error(`ZIP contains non-.dmp files. Only .dmp files are allowed within ZIP archives.`);
      }
      
      // Calculate uncompressed size
      filePromises.push(
        zipEntry.async('uint8array').then(data => {
          totalExtractedSize += data.length;
          
          // Check cumulative size
          if (totalExtractedSize > SECURITY_CONFIG.zip.maxExtractedSize) {
            throw new Error(`ZIP extraction size exceeds limit of ${formatBytes(SECURITY_CONFIG.zip.maxExtractedSize)}.`);
          }
        })
      );
    });
    
    // Wait for all file size calculations
    await Promise.all(filePromises);
    
    // Check compression ratio (potential zip bomb)
    const compressionRatio = totalExtractedSize / file.size;
    if (compressionRatio > SECURITY_CONFIG.zip.maxCompressionRatio) {
      throw new Error(`Suspicious compression ratio (${compressionRatio.toFixed(1)}:1). File may be a zip bomb.`);
    }
    
    // Check if ZIP is empty
    if (fileCount === 0) {
      throw new Error('ZIP file is empty.');
    }
    
    return {
      valid: true,
      extractedSize: totalExtractedSize,
      fileCount
    };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Failed to validate ZIP file.'
    };
  }
}

export async function extractZipSafely(file: File): Promise<{ files: File[], errors: string[] }> {
  const files: File[] = [];
  const errors: string[] = [];
  
  try {
    // Validate ZIP first
    const validation = await validateZipFile(file);
    if (!validation.valid) {
      errors.push(validation.error!);
      return { files, errors };
    }
    
    const zip = new JSZip();
    await zip.loadAsync(file);
    
    const extractPromises: Promise<void>[] = [];
    
    zip.forEach((relativePath, zipEntry) => {
      if (zipEntry.dir) return;
      
      const fileName = relativePath.split('/').pop() || '';
      if (!fileName.toLowerCase().endsWith('.dmp')) return;
      
      extractPromises.push(
        zipEntry.async('blob').then(blob => {
          const extractedFile = new File([blob], fileName, {
            type: 'application/octet-stream',
            lastModified: zipEntry.date.getTime()
          });
          files.push(extractedFile);
        }).catch(err => {
          errors.push(`Failed to extract ${fileName}: ${err.message}`);
        })
      );
    });
    
    await Promise.all(extractPromises);
    
    return { files, errors };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Failed to extract ZIP file.');
    return { files, errors };
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}