/**
 * Client-side service for server-side archive extraction (.7z, .rar)
 */

const SERVER_ARCHIVE_EXTENSIONS = ['.7z', '.rar'];

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
    throw new Error(result.error || 'Failed to extract archive');
  }

  // Convert base64 responses back to File objects
  const files: File[] = result.files.map((extracted: { fileName: string; data: string; size: number }) => {
    const binaryString = atob(extracted.data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    return new File([blob], extracted.fileName, { type: 'application/octet-stream' });
  });

  return files;
}
