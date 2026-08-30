import { SECURITY_CONFIG } from '../config/security';

export function sanitizeExtractedContent(content: string): string {
  // Remove null bytes and other control characters
  let sanitized = content.replace(new RegExp('\\x00', 'g'), '');

  // Remove non-printable characters except common whitespace
  sanitized = sanitized.replace(new RegExp('[^\\x20-\\x7E\\t\\n\\r]', 'g'), '');

  // Limit the length
  if (sanitized.length > SECURITY_CONFIG.processing.maxStringLength) {
    sanitized = sanitized.substring(0, SECURITY_CONFIG.processing.maxStringLength);
  }

  // No HTML-pattern stripping here (issue #81): this text is never rendered as
  // HTML — it is React-escaped on display and prompt-wrapped for the model —
  // and the previous regexes ("on\w+=" etc.) were both trivially bypassable
  // and destructive to legitimate dump evidence like "session=" tokens.

  return sanitized;
}

export function sanitizeHexDump(buffer: ArrayBuffer): string {
  const maxSize = Math.min(buffer.byteLength, SECURITY_CONFIG.processing.maxHexDumpSize);
  const bytes = new Uint8Array(buffer, 0, maxSize);
  
  let hexDump = '';
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.subarray(i, Math.min(i + 16, bytes.length));
    const hex = Array.from(chunk, byte => byte.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(chunk, byte => 
      byte >= 0x20 && byte <= 0x7E ? String.fromCharCode(byte) : '.'
    ).join('');
    
    hexDump += `${i.toString(16).padStart(8, '0')}  ${hex.padEnd(48, ' ')}  |${ascii}|\n`;
  }
  
  return hexDump;
}

export function validateProcessingTimeout(startTime: number): boolean {
  return Date.now() - startTime < SECURITY_CONFIG.processing.processingTimeout;
}