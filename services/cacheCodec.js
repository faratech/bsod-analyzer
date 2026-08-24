import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { promisify, TextDecoder } from 'node:util';
import {
  constants as zlibConstants,
  zstdCompress,
  zstdDecompress
} from 'node:zlib';

export const ZSTD_ENVELOPE_MAGIC = 'BSODZSTD';
export const ZSTD_ENVELOPE_VERSION = 1;
export const ZSTD_DICTIONARY_ID_BYTES = 32;
export const ZSTD_ENVELOPE_HEADER_BYTES =
  Buffer.byteLength(ZSTD_ENVELOPE_MAGIC, 'ascii') + 1 + ZSTD_DICTIONARY_ID_BYTES;
export const MAX_ANALYSIS_CACHE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_ZSTD_COMPRESSION_LEVEL = 3;

const ENVELOPE_MAGIC_BYTES = Buffer.from(ZSTD_ENVELOPE_MAGIC, 'ascii');
const ENVELOPE_VERSION_OFFSET = ENVELOPE_MAGIC_BYTES.length;
const ENVELOPE_DICTIONARY_ID_OFFSET = ENVELOPE_VERSION_OFFSET + 1;
const ZSTD_FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const DICTIONARY_ID_RE = /^[a-f0-9]{64}$/;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const zstdCompressAsync = promisify(zstdCompress);
const zstdDecompressAsync = promisify(zstdDecompress);

export class AnalysisCacheCodecError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = this.constructor.name;
    this.code = code;
  }
}

export class InvalidAnalysisCacheValueError extends AnalysisCacheCodecError {
  constructor(message, options) {
    super(message, 'INVALID_ANALYSIS_CACHE_VALUE', options);
  }
}

export class AnalysisCacheValueTooLargeError extends AnalysisCacheCodecError {
  constructor(maxBytes, options) {
    super(
      `Analysis cache value exceeds the ${maxBytes}-byte uncompressed limit`,
      'ANALYSIS_CACHE_VALUE_TOO_LARGE',
      options
    );
    this.maxBytes = maxBytes;
  }
}

export class InvalidZstdEnvelopeError extends AnalysisCacheCodecError {
  constructor(message, options) {
    super(message, 'INVALID_ZSTD_ENVELOPE', options);
  }
}

export class UnsupportedZstdEnvelopeVersionError extends AnalysisCacheCodecError {
  constructor(version) {
    super(
      `Unsupported analysis cache Zstandard envelope version: ${version}`,
      'UNSUPPORTED_ZSTD_ENVELOPE_VERSION'
    );
    this.version = version;
  }
}

export class UnknownZstdDictionaryError extends AnalysisCacheCodecError {
  constructor(dictionaryId) {
    super(
      `Zstandard dictionary is unavailable: ${dictionaryId}`,
      'UNKNOWN_ZSTD_DICTIONARY'
    );
    this.dictionaryId = dictionaryId;
  }
}

export class ZstdDictionaryError extends AnalysisCacheCodecError {
  constructor(message, options) {
    super(message, 'INVALID_ZSTD_DICTIONARY', options);
  }
}

function asBuffer(value, label) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new ZstdDictionaryError(`${label} must be a Buffer or Uint8Array`);
}

function validateDictionaryId(dictionaryId, label = 'Dictionary ID') {
  if (typeof dictionaryId !== 'string' || !DICTIONARY_ID_RE.test(dictionaryId)) {
    throw new ZstdDictionaryError(`${label} must be a lowercase SHA-256 hex digest`);
  }
}

/** Return the lowercase SHA-256 digest of the exact dictionary bytes. */
export function getDictionaryId(dictionary) {
  return createHash('sha256')
    .update(asBuffer(dictionary, 'Dictionary'))
    .digest('hex');
}

async function verifyDictionaryRoundTrip(dictionary) {
  const probe = Buffer.from('BSOD analysis cache dictionary startup probe', 'utf8');
  try {
    const compressed = await zstdCompressAsync(probe, { dictionary });
    const decompressed = await zstdDecompressAsync(compressed, {
      dictionary,
      maxOutputLength: probe.length
    });
    if (!decompressed.equals(probe)) {
      throw new Error('Zstandard dictionary round-trip returned different bytes');
    }
  } catch (error) {
    throw new ZstdDictionaryError('The current Zstandard dictionary failed validation', {
      cause: error
    });
  }
}

/**
 * Load and manage the active dictionary and lazily fetched historical ones.
 *
 * fetchDictionaryById receives a lowercase SHA-256 hex ID and must return a
 * Buffer/Uint8Array, or null when that dictionary is unavailable.
 */
export async function createDictionaryManager({
  dictionaryPath,
  expectedDictionaryId,
  fetchDictionaryById
} = {}) {
  if (!dictionaryPath) {
    throw new ZstdDictionaryError('A Zstandard dictionary path is required');
  }
  if (expectedDictionaryId !== undefined) {
    validateDictionaryId(expectedDictionaryId, 'Expected dictionary ID');
  }
  if (fetchDictionaryById !== undefined && typeof fetchDictionaryById !== 'function') {
    throw new ZstdDictionaryError('fetchDictionaryById must be a function');
  }

  let currentDictionary;
  try {
    currentDictionary = await readFile(dictionaryPath);
  } catch (error) {
    throw new ZstdDictionaryError(
      `Unable to load Zstandard dictionary from ${dictionaryPath}`,
      { cause: error }
    );
  }

  if (currentDictionary.length === 0) {
    throw new ZstdDictionaryError('The current Zstandard dictionary is empty');
  }

  const currentDictionaryId = getDictionaryId(currentDictionary);
  if (expectedDictionaryId !== undefined && expectedDictionaryId !== currentDictionaryId) {
    throw new ZstdDictionaryError(
      `Current Zstandard dictionary ID ${currentDictionaryId} does not match expected ID ${expectedDictionaryId}`
    );
  }
  await verifyDictionaryRoundTrip(currentDictionary);

  const historicalDictionaries = new Map();
  const pendingFetches = new Map();

  async function fetchHistoricalDictionary(dictionaryId) {
    if (!fetchDictionaryById) return null;

    let dictionary;
    try {
      dictionary = await fetchDictionaryById(dictionaryId);
    } catch (error) {
      throw new ZstdDictionaryError(
        `Unable to fetch Zstandard dictionary ${dictionaryId}`,
        { cause: error }
      );
    }

    if (dictionary === null || dictionary === undefined) return null;

    const bytes = Buffer.from(asBuffer(dictionary, 'Fetched dictionary'));
    if (bytes.length === 0) {
      throw new ZstdDictionaryError(`Fetched Zstandard dictionary ${dictionaryId} is empty`);
    }
    const actualId = getDictionaryId(bytes);
    if (actualId !== dictionaryId) {
      throw new ZstdDictionaryError(
        `Fetched Zstandard dictionary hash ${actualId} does not match requested ID ${dictionaryId}`
      );
    }

    historicalDictionaries.set(dictionaryId, bytes);
    return bytes;
  }

  return Object.freeze({
    currentDictionaryId,

    getCurrentDictionary() {
      return {
        id: currentDictionaryId,
        bytes: currentDictionary
      };
    },

    async getDictionary(dictionaryId) {
      validateDictionaryId(dictionaryId);

      if (dictionaryId === currentDictionaryId) return currentDictionary;
      if (historicalDictionaries.has(dictionaryId)) {
        return historicalDictionaries.get(dictionaryId);
      }
      if (pendingFetches.has(dictionaryId)) return pendingFetches.get(dictionaryId);

      const pending = fetchHistoricalDictionary(dictionaryId);
      pendingFetches.set(dictionaryId, pending);
      try {
        return await pending;
      } finally {
        pendingFetches.delete(dictionaryId);
      }
    }
  });
}

/** True for binary values carrying the cache envelope magic, including unknown versions. */
export function isZstdEnvelope(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) return false;
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return bytes.length >= ENVELOPE_MAGIC_BYTES.length &&
    bytes.subarray(0, ENVELOPE_MAGIC_BYTES.length).equals(ENVELOPE_MAGIC_BYTES);
}

function parseEnvelope(value) {
  const envelope = Buffer.isBuffer(value)
    ? value
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);

  if (envelope.length < ZSTD_ENVELOPE_HEADER_BYTES + ZSTD_FRAME_MAGIC.length) {
    throw new InvalidZstdEnvelopeError('Zstandard analysis cache envelope is truncated');
  }

  const version = envelope[ENVELOPE_VERSION_OFFSET];
  if (version !== ZSTD_ENVELOPE_VERSION) {
    throw new UnsupportedZstdEnvelopeVersionError(version);
  }

  const dictionaryId = envelope
    .subarray(
      ENVELOPE_DICTIONARY_ID_OFFSET,
      ENVELOPE_DICTIONARY_ID_OFFSET + ZSTD_DICTIONARY_ID_BYTES
    )
    .toString('hex');
  const frame = envelope.subarray(ZSTD_ENVELOPE_HEADER_BYTES);
  if (!frame.subarray(0, ZSTD_FRAME_MAGIC.length).equals(ZSTD_FRAME_MAGIC)) {
    throw new InvalidZstdEnvelopeError('Zstandard analysis cache frame has invalid magic bytes');
  }

  return { dictionaryId, frame };
}

/** Read the SHA-256 dictionary ID from a validated binary envelope. */
export function getEnvelopeDictionaryId(value) {
  if (!isZstdEnvelope(value)) {
    throw new InvalidZstdEnvelopeError('Value does not have Zstandard analysis cache envelope magic');
  }
  return parseEnvelope(value).dictionaryId;
}

function buildEnvelope(dictionaryId, frame) {
  validateDictionaryId(dictionaryId);
  const envelope = Buffer.allocUnsafe(ZSTD_ENVELOPE_HEADER_BYTES + frame.length);
  ENVELOPE_MAGIC_BYTES.copy(envelope, 0);
  envelope[ENVELOPE_VERSION_OFFSET] = ZSTD_ENVELOPE_VERSION;
  Buffer.from(dictionaryId, 'hex').copy(envelope, ENVELOPE_DICTIONARY_ID_OFFSET);
  frame.copy(envelope, ZSTD_ENVELOPE_HEADER_BYTES);
  return envelope;
}

function decodeJsonBytes(bytes, maxDecompressedBytes) {
  if (bytes.length > maxDecompressedBytes) {
    throw new AnalysisCacheValueTooLargeError(maxDecompressedBytes);
  }

  let json;
  try {
    json = utf8Decoder.decode(bytes);
  } catch (error) {
    throw new InvalidAnalysisCacheValueError('Analysis cache value is not valid UTF-8', {
      cause: error
    });
  }

  try {
    return JSON.parse(json);
  } catch (error) {
    throw new InvalidAnalysisCacheValueError('Analysis cache value is not valid JSON', {
      cause: error
    });
  }
}

function serializeJson(value, maxDecompressedBytes) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new InvalidAnalysisCacheValueError('Analysis cache value cannot be serialized as JSON', {
      cause: error
    });
  }
  if (json === undefined) {
    throw new InvalidAnalysisCacheValueError('Analysis cache value cannot be serialized as JSON');
  }

  const bytes = Buffer.from(json, 'utf8');
  if (bytes.length > maxDecompressedBytes) {
    throw new AnalysisCacheValueTooLargeError(maxDecompressedBytes);
  }
  return bytes;
}

/**
 * Create the async analysis-cache codec.
 *
 * encode(value, { compress: false }) emits raw UTF-8 JSON for reader-only
 * rollout. With compression enabled, it emits an envelope only when the full
 * binary envelope is smaller than that raw JSON Buffer.
 */
export function createAnalysisCacheCodec({
  dictionaryManager,
  compressionLevel = DEFAULT_ZSTD_COMPRESSION_LEVEL,
  maxDecompressedBytes = MAX_ANALYSIS_CACHE_BYTES
} = {}) {
  if (!dictionaryManager ||
      typeof dictionaryManager.getCurrentDictionary !== 'function' ||
      typeof dictionaryManager.getDictionary !== 'function') {
    throw new ZstdDictionaryError('A valid Zstandard dictionary manager is required');
  }
  if (!Number.isInteger(compressionLevel)) {
    throw new TypeError('compressionLevel must be an integer');
  }
  if (!Number.isSafeInteger(maxDecompressedBytes) || maxDecompressedBytes <= 0) {
    throw new TypeError('maxDecompressedBytes must be a positive safe integer');
  }

  return Object.freeze({
    async encode(value, { compress = true } = {}) {
      if (typeof compress !== 'boolean') {
        throw new TypeError('compress must be a boolean');
      }

      const jsonBytes = serializeJson(value, maxDecompressedBytes);
      if (!compress) return jsonBytes;

      const current = dictionaryManager.getCurrentDictionary();
      if (!current || !current.bytes) {
        throw new ZstdDictionaryError('The current Zstandard dictionary is unavailable');
      }
      validateDictionaryId(current.id, 'Current dictionary ID');
      const dictionary = asBuffer(current.bytes, 'Current dictionary');
      if (getDictionaryId(dictionary) !== current.id) {
        throw new ZstdDictionaryError('The current Zstandard dictionary does not match its ID');
      }

      let frame;
      try {
        frame = await zstdCompressAsync(jsonBytes, {
          dictionary,
          params: {
            [zlibConstants.ZSTD_c_compressionLevel]: compressionLevel
          }
        });
      } catch (error) {
        throw new AnalysisCacheCodecError(
          'Unable to Zstandard-compress analysis cache value',
          'ZSTD_COMPRESSION_FAILED',
          { cause: error }
        );
      }

      const envelope = buildEnvelope(current.id, frame);
      return envelope.length < jsonBytes.length ? envelope : jsonBytes;
    },

    async decode(storedValue) {
      if (storedValue !== null && typeof storedValue === 'object' &&
          !Buffer.isBuffer(storedValue) && !(storedValue instanceof Uint8Array)) {
        return storedValue;
      }

      if (typeof storedValue === 'string') {
        return decodeJsonBytes(Buffer.from(storedValue, 'utf8'), maxDecompressedBytes);
      }

      if (!Buffer.isBuffer(storedValue) && !(storedValue instanceof Uint8Array)) {
        throw new InvalidAnalysisCacheValueError(
          'Analysis cache value must be an object, JSON string, Buffer, or Uint8Array'
        );
      }

      const bytes = Buffer.isBuffer(storedValue)
        ? storedValue
        : Buffer.from(storedValue.buffer, storedValue.byteOffset, storedValue.byteLength);
      if (!isZstdEnvelope(bytes)) {
        return decodeJsonBytes(bytes, maxDecompressedBytes);
      }

      const { dictionaryId, frame } = parseEnvelope(bytes);
      const dictionary = await dictionaryManager.getDictionary(dictionaryId);
      if (!dictionary) throw new UnknownZstdDictionaryError(dictionaryId);

      let decompressed;
      try {
        decompressed = await zstdDecompressAsync(frame, {
          dictionary: asBuffer(dictionary, 'Zstandard dictionary'),
          maxOutputLength: maxDecompressedBytes
        });
      } catch (error) {
        if (error?.code === 'ERR_BUFFER_TOO_LARGE') {
          throw new AnalysisCacheValueTooLargeError(maxDecompressedBytes, { cause: error });
        }
        throw new AnalysisCacheCodecError(
          'Unable to Zstandard-decompress analysis cache value',
          'ZSTD_DECOMPRESSION_FAILED',
          { cause: error }
        );
      }

      return decodeJsonBytes(decompressed, maxDecompressedBytes);
    }
  });
}
