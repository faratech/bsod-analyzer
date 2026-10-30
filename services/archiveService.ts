/**
 * Client-side service for server-side archive extraction (.7z, .rar)
 */

import { handleSessionError } from '../utils/sessionManager';
import { dataUseHeaders } from '../utils/dataUse';
import { ARCHIVE_EXTENSIONS } from '../shared/ingestPolicy.js';
import { extractZipSafely } from '../utils/zipSecurity';

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
    headers: dataUseHeaders(),
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

  // The returned ZIP is server-produced, but it is still untrusted input to
  // this tab: validate entry sizes/count before materializing anything, the
  // same way user-supplied ZIPs are handled (issue #81).
  const returnedZip = new File([payload], 'extracted-dumps.zip', { type: 'application/zip' });
  // extractZipSafely validates the entries, then inflates them one at a time
  // with a running byte counter bounded by each declared size (issue #233).
  const { files, errors } = await extractZipSafely(returnedZip);
  if (errors.length > 0) {
    throw new Error(errors[0] || 'Server returned an invalid archive');
  }
  return files;
}
