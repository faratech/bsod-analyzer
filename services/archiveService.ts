/**
 * Client-side service for server-side archive extraction (.7z, .rar)
 */

import { handleSessionError } from '../utils/sessionManager';
import { ARCHIVE_EXTENSIONS } from '../shared/ingestPolicy.js';
import JSZip from 'jszip';

const SERVER_ARCHIVE_EXTENSIONS = ARCHIVE_EXTENSIONS.filter(ext => ext !== '.zip');

/**
 * Check if a file needs server-side extraction (7z or RAR)
 */
export function isServerSideArchive(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return SERVER_ARCHIVE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

/**
 * Upload an archive to the server for extraction, returns extracted .dmp Files
 */
export async function extractArchiveServerSide(file: File): Promise<File[]> {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch('/api/extract-archive', {
    method: 'POST',
    credentials: 'include',
    body: formData
  });

  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    if (response.status === 401) {
      handleSessionError(result);
    }
    throw new Error(result.error || 'Failed to extract archive');
  }

  const payload = await response.arrayBuffer();
  const zip = await JSZip.loadAsync(payload);
  const files: File[] = [];
  const entries = Object.entries(zip.files).filter(([, entry]) => !entry.dir);

  await Promise.all(entries.map(async ([sourcePath, entry]) => {
      const blob = await entry.async('blob');
      const fileName = sourcePath.split('/').pop() || 'dump.dmp';
      const file = new File([blob], fileName, {
        type: 'application/octet-stream',
        lastModified: entry.date?.getTime?.() || Date.now()
      }) as File & { sourcePath?: string };
      Object.defineProperty(file, 'sourcePath', {
        value: sourcePath,
        enumerable: false
      });
      files.push(file);
  }));

  return files;
}
