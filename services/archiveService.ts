/**
 * Client-side service for server-side archive extraction (.7z, .rar)
 */

import { handleSessionError } from '../utils/sessionManager';
import { ARCHIVE_EXTENSIONS } from '../shared/ingestPolicy.js';

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

  const result = await response.json();

  if (!response.ok || !result.success) {
    if (response.status === 401) {
      handleSessionError(result);
    }
    throw new Error(result.error || 'Failed to extract archive');
  }

  // Convert base64 responses back to File objects natively via data URL
  const files: File[] = await Promise.all(
    result.files.map(async (extracted: { fileName: string; data: string; size: number }) => {
      const response = await fetch(`data:application/octet-stream;base64,${extracted.data}`);
      const blob = await response.blob();
      return new File([blob], extracted.fileName, { type: 'application/octet-stream' });
    })
  );

  return files;
}
