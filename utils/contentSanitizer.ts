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
  
  // Remove potential script injection patterns
  const dangerousPatterns = [
    /<script[\s\S]*?<\/script>/gi,
    /<iframe[\s\S]*?<\/iframe>/gi,
    /javascript:/gi,
    /on\w+\s*=/gi, // onclick=, onload=, etc.
    /<object[\s\S]*?<\/object>/gi,
    /<embed[\s\S]*?>/gi,
  ];
  
  for (const pattern of dangerousPatterns) {
    sanitized = sanitized.replace(pattern, '[REMOVED]');
  }
  
  return sanitized;
}

export function sanitizeHexDump(buffer: ArrayBuffer): string {
  const maxSize = Math.min(buffer.byteLength, SECURITY_CONFIG.processing.maxHexDumpSize);
  const bytes = new Uint8Array(buffer.slice(0, maxSize));
  
  let hexDump = '';
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.slice(i, Math.min(i + 16, bytes.length));
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