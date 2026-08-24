import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AnalysisCacheCodecError,
  AnalysisCacheValueTooLargeError,
  InvalidAnalysisCacheValueError,
  InvalidZstdEnvelopeError,
  UnsupportedZstdEnvelopeVersionError,
  UnknownZstdDictionaryError,
  ZSTD_ENVELOPE_HEADER_BYTES,
  ZSTD_ENVELOPE_MAGIC,
  ZSTD_ENVELOPE_VERSION,
  ZstdDictionaryError,
  createAnalysisCacheCodec,
  createDictionaryManager,
  getDictionaryId,
  getEnvelopeDictionaryId,
  isZstdEnvelope
} from '../services/cacheCodec.js';

const ACTIVE_DICTIONARY = Buffer.from(
  'BUGCHECK_CODE MODULE_NAME IMAGE_NAME STACK_TEXT FAILURE_BUCKET_ID ' +
  'PROCESS_NAME SYMBOL_NAME analysisSignalText structured aiReport recommendations\n'.repeat(128)
);
const OLD_DICTIONARY = Buffer.from(
  'Microsoft Windows Debugger Version KERNEL_MODE_EXCEPTION_NOT_HANDLED ' +
  'DEFAULT_BUCKET_ID memory_corruption followup machine_owner\n'.repeat(128)
);

async function managerFromBytes(t, dictionary, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bsod-cache-codec-'));
  const dictionaryPath = join(directory, 'dictionary.zstd');
  await writeFile(dictionaryPath, dictionary);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return createDictionaryManager({ dictionaryPath, ...options });
}

function largeAnalysis(label = 'active') {
  return {
    windbgOutput: (
      `BUGCHECK_CODE:  0x133\nMODULE_NAME: ${label}_driver\n` +
      'STACK_TEXT: nt!KeBugCheckEx nt!KiUpdateRunTime nt!KiUpdateTime\n'
    ).repeat(750),
    analysisSignalText: 'Probable driver fault — résumé 日本語',
    structured: {
      bugcheck: 'DPC_WATCHDOG_VIOLATION',
      modules: [`${label}_driver.sys`, 'ntoskrnl.exe']
    },
    aiReports: {
      'gemini-3-flash-preview': { summary: `${label} report`, recommendations: ['Update'] }
    },
    timestamp: 1_725_000_000_000
  };
}

test('dictionary manager derives and verifies IDs from exact file bytes', async t => {
  const expectedId = createHash('sha256').update(ACTIVE_DICTIONARY).digest('hex');
  const manager = await managerFromBytes(t, ACTIVE_DICTIONARY, {
    expectedDictionaryId: expectedId
  });

  assert.equal(getDictionaryId(ACTIVE_DICTIONARY), expectedId);
  assert.equal(manager.currentDictionaryId, expectedId);
  assert.equal(manager.getCurrentDictionary().id, expectedId);
  assert.deepEqual(manager.getCurrentDictionary().bytes, ACTIVE_DICTIONARY);
  assert.deepEqual(await manager.getDictionary(expectedId), ACTIVE_DICTIONARY);
});

test('dictionary manager rejects a wrong expected hash and bad historical bytes', async t => {
  await assert.rejects(
    managerFromBytes(t, ACTIVE_DICTIONARY, {
      expectedDictionaryId: '0'.repeat(64)
    }),
    error => error instanceof ZstdDictionaryError &&
      error.code === 'INVALID_ZSTD_DICTIONARY'
  );

  const oldId = getDictionaryId(OLD_DICTIONARY);
  const manager = await managerFromBytes(t, ACTIVE_DICTIONARY, {
    fetchDictionaryById: async () => Buffer.from('not the requested dictionary')
  });
  await assert.rejects(
    manager.getDictionary(oldId),
    error => error instanceof ZstdDictionaryError &&
      error.message.includes('does not match requested ID')
  );
});

test('codec emits the compact binary envelope and round-trips analysis data', async t => {
  const manager = await managerFromBytes(t, ACTIVE_DICTIONARY);
  const codec = createAnalysisCacheCodec({ dictionaryManager: manager });
  const analysis = largeAnalysis();
  const rawBytes = Buffer.from(JSON.stringify(analysis));
  const encoded = await codec.encode(analysis);

  assert.ok(Buffer.isBuffer(encoded));
  assert.equal(isZstdEnvelope(encoded), true);
  assert.equal(encoded.subarray(0, 8).toString('ascii'), ZSTD_ENVELOPE_MAGIC);
  assert.equal(encoded[8], ZSTD_ENVELOPE_VERSION);
  assert.equal(ZSTD_ENVELOPE_HEADER_BYTES, 41);
  assert.equal(getEnvelopeDictionaryId(encoded), manager.currentDictionaryId);
  assert.deepEqual(
    encoded.subarray(9, 41),
    Buffer.from(manager.currentDictionaryId, 'hex')
  );
  assert.deepEqual(encoded.subarray(41, 45), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
  assert.ok(encoded.length < rawBytes.length);
  assert.deepEqual(await codec.decode(encoded), analysis);
});

test('codec supports reader-only raw writes and keeps small values raw', async t => {
  const manager = await managerFromBytes(t, ACTIVE_DICTIONARY);
  const codec = createAnalysisCacheCodec({ dictionaryManager: manager });
  const value = { ok: true };

  const readerOnly = await codec.encode(value, { compress: false });
  const sizeFallback = await codec.encode(value);

  assert.deepEqual(readerOnly, Buffer.from(JSON.stringify(value)));
  assert.deepEqual(sizeFallback, Buffer.from(JSON.stringify(value)));
  assert.equal(isZstdEnvelope(readerOnly), false);
  assert.equal(isZstdEnvelope(sizeFallback), false);
  assert.deepEqual(await codec.decode(readerOnly), value);
});

test('codec reads legacy JSON strings, binary JSON, Uint8Arrays, and deserialized objects', async t => {
  const manager = await managerFromBytes(t, ACTIVE_DICTIONARY);
  const codec = createAnalysisCacheCodec({ dictionaryManager: manager });
  const value = { windbgOutput: 'legacy', structured: { code: 10 } };
  const json = JSON.stringify(value);

  assert.deepEqual(await codec.decode(json), value);
  assert.deepEqual(await codec.decode(Buffer.from(json)), value);
  assert.deepEqual(await codec.decode(new Uint8Array(Buffer.from(json))), value);
  assert.equal(await codec.decode(value), value);
});

test('codec lazily fetches and caches an older dictionary by envelope ID', async t => {
  const oldManager = await managerFromBytes(t, OLD_DICTIONARY);
  const oldCodec = createAnalysisCacheCodec({ dictionaryManager: oldManager });
  const analysis = largeAnalysis('old');
  const encodedWithOldDictionary = await oldCodec.encode(analysis);
  assert.equal(isZstdEnvelope(encodedWithOldDictionary), true);

  let fetchCount = 0;
  const activeManager = await managerFromBytes(t, ACTIVE_DICTIONARY, {
    fetchDictionaryById: async dictionaryId => {
      fetchCount++;
      assert.equal(dictionaryId, oldManager.currentDictionaryId);
      return OLD_DICTIONARY;
    }
  });
  const activeCodec = createAnalysisCacheCodec({ dictionaryManager: activeManager });

  assert.deepEqual(await activeCodec.decode(encodedWithOldDictionary), analysis);
  assert.deepEqual(await activeCodec.decode(encodedWithOldDictionary), analysis);
  assert.equal(fetchCount, 1);
});

test('codec strictly rejects unknown dictionaries and malformed envelopes', async t => {
  const manager = await managerFromBytes(t, ACTIVE_DICTIONARY, {
    fetchDictionaryById: async () => null
  });
  const codec = createAnalysisCacheCodec({ dictionaryManager: manager });
  const encoded = await codec.encode(largeAnalysis());

  const unknownDictionary = Buffer.from(encoded);
  Buffer.from('a'.repeat(64), 'hex').copy(unknownDictionary, 9);
  await assert.rejects(
    codec.decode(unknownDictionary),
    error => error instanceof UnknownZstdDictionaryError &&
      error.code === 'UNKNOWN_ZSTD_DICTIONARY'
  );

  const truncated = Buffer.concat([
    Buffer.from(ZSTD_ENVELOPE_MAGIC, 'ascii'),
    Buffer.from([ZSTD_ENVELOPE_VERSION])
  ]);
  await assert.rejects(
    codec.decode(truncated),
    error => error instanceof InvalidZstdEnvelopeError
  );

  const unsupported = Buffer.from(encoded);
  unsupported[8] = 2;
  await assert.rejects(
    codec.decode(unsupported),
    error => error instanceof UnsupportedZstdEnvelopeVersionError && error.version === 2
  );

  const badFrameMagic = Buffer.from(encoded);
  badFrameMagic[ZSTD_ENVELOPE_HEADER_BYTES] ^= 0xff;
  await assert.rejects(
    codec.decode(badFrameMagic),
    error => error instanceof InvalidZstdEnvelopeError
  );

  const truncatedFrame = encoded.subarray(0, encoded.length - 1);
  await assert.rejects(
    codec.decode(truncatedFrame),
    error => error instanceof AnalysisCacheCodecError
  );
});

test('codec rejects invalid JSON, invalid UTF-8, and oversized decompressed data', async t => {
  const manager = await managerFromBytes(t, ACTIVE_DICTIONARY);
  const normalCodec = createAnalysisCacheCodec({
    dictionaryManager: manager,
    maxDecompressedBytes: 4096
  });
  const limitedCodec = createAnalysisCacheCodec({
    dictionaryManager: manager,
    maxDecompressedBytes: 128
  });
  const encoded = await normalCodec.encode({ text: 'x'.repeat(2048) });
  assert.equal(isZstdEnvelope(encoded), true);

  await assert.rejects(
    limitedCodec.decode(encoded),
    error => error instanceof AnalysisCacheValueTooLargeError &&
      error.code === 'ANALYSIS_CACHE_VALUE_TOO_LARGE'
  );
  await assert.rejects(
    limitedCodec.decode(Buffer.from(JSON.stringify({ text: 'x'.repeat(256) }))),
    error => error instanceof AnalysisCacheValueTooLargeError
  );
  await assert.rejects(
    normalCodec.decode(Buffer.from('{bad json')),
    error => error instanceof InvalidAnalysisCacheValueError
  );
  await assert.rejects(
    normalCodec.decode(Buffer.from([0xff, 0xfe, 0xfd])),
    error => error instanceof InvalidAnalysisCacheValueError
  );
});
