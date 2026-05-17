import test from 'node:test';
import assert from 'node:assert/strict';
import xxhash from 'xxhash-wasm';
import { HASH_HEX_RE, hashBytes, hashString, legacyHashBytes } from '../shared/hash.js';

test('raw-byte hashes are stable 64-bit hex values', async () => {
  const hasher = await xxhash();
  const bytes = new Uint8Array([0, 1, 2, 3, 255, 128, 64]);
  const first = hashBytes(hasher, bytes);
  const second = hashBytes(hasher, bytes);

  assert.match(first, HASH_HEX_RE);
  assert.equal(first, second);
});

test('legacy byte hashing remains available for one-cache-TTL compatibility reads', async () => {
  const hasher = await xxhash();
  const bytes = new Uint8Array([0x80, 0x81, 0x82, 0xff]);

  assert.notEqual(hashBytes(hasher, bytes), legacyHashBytes(hasher, bytes));
  assert.equal(hashString(hasher, 'same text'), hasher.h64ToString('same text'));
});
