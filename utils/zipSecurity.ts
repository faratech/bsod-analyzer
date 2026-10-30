import JSZip from 'jszip';
import { SECURITY_CONFIG } from '../config/security';
import { formatBytes, isDumpFileName, validatePathEntry } from '../shared/ingestPolicy.js';

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
      if (!validatePathEntry(relativePath, SECURITY_CONFIG.zip.maxDepth)) {
        throw new Error(`ZIP contains files nested too deeply. Maximum depth is ${SECURITY_CONFIG.zip.maxDepth}.`);
      }

      // Skip directories
      if (zipEntry.dir) {
        return;
      }

      fileCount++;

      // Check file count limit
      if (fileCount > SECURITY_CONFIG.zip.maxFileCount) {
        throw new Error(`ZIP contains too many files. Maximum ${SECURITY_CONFIG.zip.maxFileCount} files allowed.`);
      }

      // Check file extension
      const fileName = relativePath.split('/').pop() || '';
      if (!isDumpFileName(fileName)) {
        throw new Error(`ZIP contains non-dump files. Only .dmp, .mdmp, .hdmp, and .kdmp files are allowed within ZIP archives.`);
      }

      // Safely check uncompressed size from metadata first to avoid decompressing
      const listedSize = (zipEntry as any)._data?.uncompressedSize;
      if (typeof listedSize === 'number') {
        totalExtractedSize += listedSize;
        if (totalExtractedSize > SECURITY_CONFIG.zip.maxExtractedSize) {
          throw new Error(`ZIP extraction size exceeds limit of ${formatBytes(SECURITY_CONFIG.zip.maxExtractedSize)}.`);
        }
      } else {
        // Without trusted size metadata we would have to fully decompress the
        // entry BEFORE knowing its size - a crafted archive could exhaust
        // memory client-side. Reject rather than guess.
        throw new Error('ZIP entry is missing uncompressed size metadata and cannot be safely validated.');
      }
    });

    // Wait for all file size calculations
    await Promise.all(filePromises);

    // Check compression ratio (potential zip bomb)
    const compressionRatio = file.size > 0 ? totalExtractedSize / file.size : Infinity;
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

// JSZip's streaming API (StreamHelper); its typings omit internalStream.
interface ZipEntryStream {
  on(event: 'data', fn: (chunk: Uint8Array) => void): ZipEntryStream;
  on(event: 'error', fn: (err: Error) => void): ZipEntryStream;
  on(event: 'end', fn: () => void): ZipEntryStream;
  pause(): ZipEntryStream;
  resume(): ZipEntryStream;
}

/**
 * Inflate one entry as a stream, counting the real output bytes, and abort as
 * soon as it passes `maxBytes`. The central-directory size is attacker
 * controlled and JSZip only checks it after inflating the whole entry, so the
 * size checks in validateZipFile cannot bound memory on their own (issue #233).
 */
export class ZipEntryLimitError extends Error {}

export function readZipEntryBounded(zipEntry: JSZip.JSZipObject, maxBytes: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;
    const stream = (zipEntry as unknown as { internalStream(type: 'uint8array'): ZipEntryStream })
      .internalStream('uint8array');
    stream
      .on('data', chunk => {
        if (settled) return;
        total += chunk.length;
        if (total > maxBytes) {
          settled = true;
          chunks.length = 0;
          stream.pause();
          reject(new ZipEntryLimitError(`entry exceeds its declared size (more than ${formatBytes(maxBytes)} when inflated)`));
          return;
        }
        chunks.push(chunk);
      })
      .on('error', err => {
        if (settled) return;
        settled = true;
        chunks.length = 0;
        reject(err);
      })
      .on('end', () => {
        if (settled) return;
        settled = true;
        resolve(new Blob(chunks as BlobPart[]));
      })
      .resume();
  });
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

    const entries: Array<[string, JSZip.JSZipObject]> = [];
    zip.forEach((relativePath, zipEntry) => {
      if (zipEntry.dir) return;
      const fileName = relativePath.split('/').pop() || '';
      if (!isDumpFileName(fileName)) return;
      entries.push([relativePath, zipEntry]);
    });

    // One entry at a time, each capped at its declared size and at what is
    // left of the archive budget, so the real output can never exceed what
    // validateZipFile accepted. A failed entry only drops itself (issue
    // #279); the whole archive is discarded only when an entry overruns the
    // shared budget, since then the archive as a whole is lying.
    let remaining = SECURITY_CONFIG.zip.maxExtractedSize;
    for (const [relativePath, zipEntry] of entries) {
      const fileName = relativePath.split('/').pop() || '';
      const declared = (zipEntry as any)._data?.uncompressedSize;
      const declaredLimit = typeof declared === 'number' ? declared : 0;
      const budgetBound = declaredLimit >= remaining;
      const limit = Math.min(declaredLimit, remaining);
      let blob: Blob;
      try {
        blob = await readZipEntryBounded(zipEntry, limit);
      } catch (err) {
        if (budgetBound && err instanceof ZipEntryLimitError) {
          errors.push(`ZIP extraction size exceeds limit of ${formatBytes(SECURITY_CONFIG.zip.maxExtractedSize)}.`);
          return { files: [], errors };
        }
        errors.push(`Failed to extract ${fileName}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      remaining -= blob.size;
      const extractedFile = new File([blob], fileName, {
        type: 'application/octet-stream',
        lastModified: zipEntry.date.getTime()
      }) as File & { sourcePath?: string };
      Object.defineProperty(extractedFile, 'sourcePath', {
        value: relativePath,
        enumerable: false
      });
      files.push(extractedFile);
    }

    return { files, errors };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Failed to extract ZIP file.');
    return { files, errors };
  }
}
