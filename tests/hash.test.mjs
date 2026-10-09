import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { HASH_HEX_RE, HASH_RE, sha256Hex } from '../shared/hash.js';
import { hashContent } from '../services/cache.js';

// Issue #146: file identity is SHA-256. XXH64 has trivial second preimages, so
// an uploader could craft a different dump with a target dump's hash.
const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

test('file identity is SHA-256 hex', async () => {
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')), ABC_SHA256);
  assert.equal(await sha256Hex('abc'), ABC_SHA256);
  assert.equal(hashContent(Buffer.from('abc')), ABC_SHA256);
  assert.equal(hashContent('abc'), ABC_SHA256);
  assert.match(hashContent(Buffer.from('abc')), HASH_HEX_RE);
});

test('the browser hash (WebCrypto) and the server hash (node:crypto) agree on dump bytes', async () => {
  const bytes = crypto.randomBytes(3 * 1024 * 1024 + 17);
  const browser = await sha256Hex(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  assert.equal(browser, hashContent(bytes));
  assert.equal(browser, crypto.createHash('sha256').update(bytes).digest('hex'));
});

test('only full SHA-256 values are accepted as file hashes; legacy XXH64 values are not', () => {
  assert.equal(HASH_RE.test(ABC_SHA256), true);
  assert.equal(HASH_RE.test(ABC_SHA256.toUpperCase()), true);
  assert.equal(HASH_RE.test('0123456789abcdef'), false, '16-hex XXH64');
  assert.equal(HASH_RE.test(ABC_SHA256.slice(0, 32)), false, 'truncated');
  assert.equal(HASH_RE.test(`${ABC_SHA256}0`), false);

  // server.js keeps its own copy of the pattern; it must match.
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /^const HASH_RE = \/\^\[a-f0-9\]\{64\}\$\/i;$/m);
});
