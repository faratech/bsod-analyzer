const HASH_RE = /^[a-f0-9]{8,16}$/i;
const HASH_HEX_RE = /^[a-f0-9]{16}$/i;
const LEGACY_CHUNK_SIZE = 0x8000;

function formatHash64(value) {
  return value.toString(16).padStart(16, '0');
}

function hashBytes(hasher, bytes) {
  return formatHash64(hasher.h64Raw(bytes));
}

function hashString(hasher, value) {
  return hasher.h64ToString(String(value));
}

function legacyBinaryString(bytes) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += LEGACY_CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, offset + LEGACY_CHUNK_SIZE);
    chunks.push(String.fromCharCode(...chunk));
  }
  return chunks.join('');
}

function legacyHashBytes(hasher, bytes) {
  return hasher.h64ToString(legacyBinaryString(bytes));
}

export {
  HASH_RE,
  HASH_HEX_RE,
  formatHash64,
  hashBytes,
  hashString,
  legacyHashBytes
};
