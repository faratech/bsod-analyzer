// File identity for upload ownership, signed file handles, the WinDBG job
// binding, analysis cache keys and the file_hash recorded in stats, the corpus
// and the crash-signal table. It is SHA-256 (issue #146): the previous XXH64
// has trivial second preimages, so an uploader could craft a different dump
// with another dump's hash and take over everything keyed by it.
const HASH_RE = /^[a-f0-9]{64}$/i;
const HASH_HEX_RE = /^[a-f0-9]{64}$/;

function toHex(bytes) {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

// WebCrypto SHA-256 (browsers and Node), lowercase hex. The server hashes
// synchronously with node:crypto (services/cache.js hashContent); both must
// produce the same value for a file, since the browser sends its hash back
// with the server-signed handle.
async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return toHex(await globalThis.crypto.subtle.digest('SHA-256', bytes));
}

export {
  HASH_RE,
  HASH_HEX_RE,
  sha256Hex,
  toHex
};
