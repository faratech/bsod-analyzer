#!/usr/bin/env node

/**
 * Train and validate the private Zstandard dictionary used by the analysis
 * cache. The default operation is read-only: it samples Redis, trains in a
 * private temporary directory, prints aggregate sizes, and deletes all local
 * artifacts. A Secret Manager write requires the explicit --upload flag.
 */

import { execFile as execFileCallback } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify, TextDecoder } from 'node:util';
import {
  constants as zlibConstants,
  zstdCompressSync,
  zstdDecompressSync,
} from 'node:zlib';
import { Redis } from '@upstash/redis';

import {
  DEFAULT_ZSTD_COMPRESSION_LEVEL,
  MAX_ANALYSIS_CACHE_BYTES,
  ZSTD_ENVELOPE_HEADER_BYTES,
  ZSTD_ENVELOPE_MAGIC,
  ZSTD_ENVELOPE_VERSION,
  getDictionaryId,
  getEnvelopeDictionaryId,
  isZstdEnvelope,
} from '../services/cacheCodec.js';
import { createUpstashBinaryClient } from '../services/upstashBinary.js';

export const DEFAULT_TRAIN_COUNT = 100;
export const DEFAULT_HOLDOUT_COUNT = 25;
export const DEFAULT_DICTIONARY_SIZE = 32 * 1024;
export const DEFAULT_SCAN_COUNT = 1_000;
export const DEFAULT_PTTL_BATCH_SIZE = 100;
export const DEFAULT_SECRET_NAME = 'redis-zstd-dictionary';
export const DICTIONARY_REGISTRY_PREFIX = 'cachemeta:zstd:dictionary:';

const MAX_DICTIONARY_SOURCE_BYTES = 128 * 1024;
const DICTIONARY_ID_RE = /^[a-f0-9]{64}$/;
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9:.-]{4,127}$/i;
const SECRET_NAME_RE = /^[A-Za-z0-9_-]{1,255}$/;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const execFile = promisify(execFileCallback);

export class CacheDictionaryOperatorError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'CacheDictionaryOperatorError';
  }
}

function positiveInteger(value, label, { maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new CacheDictionaryOperatorError(
      `${label} must be a positive integer no greater than ${maximum}`,
    );
  }
  return parsed;
}

function flagValue(argv, index, name) {
  const argument = argv[index];
  const equalsPrefix = `${name}=`;
  if (argument.startsWith(equalsPrefix)) {
    const value = argument.slice(equalsPrefix.length);
    if (!value) throw new CacheDictionaryOperatorError(`${name} requires a value`);
    return { value, consumed: 0 };
  }
  if (argument === name) {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new CacheDictionaryOperatorError(`${name} requires a value`);
    }
    return { value, consumed: 1 };
  }
  return null;
}

export function parseArguments(argv) {
  const options = {
    upload: false,
    help: false,
    project: undefined,
    secret: DEFAULT_SECRET_NAME,
    dictionaryPaths: [],
    trainCount: DEFAULT_TRAIN_COUNT,
    holdoutCount: DEFAULT_HOLDOUT_COUNT,
    dictionarySize: DEFAULT_DICTIONARY_SIZE,
    scanCount: DEFAULT_SCAN_COUNT,
    pttlBatchSize: DEFAULT_PTTL_BATCH_SIZE,
    compressionLevel: DEFAULT_ZSTD_COMPRESSION_LEVEL,
    zstdPath: 'zstd',
    gcloudPath: 'gcloud',
  };

  const valueFlags = new Map([
    ['--project', 'project'],
    ['--secret', 'secret'],
    ['--dictionary', 'dictionaryPaths'],
    ['--train-count', 'trainCount'],
    ['--holdout-count', 'holdoutCount'],
    ['--dictionary-size', 'dictionarySize'],
    ['--scan-count', 'scanCount'],
    ['--pttl-batch-size', 'pttlBatchSize'],
    ['--zstd', 'zstdPath'],
    ['--gcloud', 'gcloudPath'],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--upload') {
      options.upload = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }

    let matched = false;
    for (const [flag, property] of valueFlags) {
      const parsed = flagValue(argv, index, flag);
      if (!parsed) continue;
      matched = true;
      index += parsed.consumed;
      if (property === 'dictionaryPaths') options.dictionaryPaths.push(parsed.value);
      else options[property] = parsed.value;
      break;
    }
    if (!matched) {
      // Do not reflect arbitrary command-line text: operators occasionally
      // paste a credential where a supported flag was expected.
      throw new CacheDictionaryOperatorError('Unknown or positional argument');
    }
  }

  options.trainCount = positiveInteger(options.trainCount, '--train-count', { maximum: 10_000 });
  options.holdoutCount = positiveInteger(options.holdoutCount, '--holdout-count', { maximum: 10_000 });
  options.dictionarySize = positiveInteger(options.dictionarySize, '--dictionary-size', {
    maximum: MAX_DICTIONARY_SOURCE_BYTES,
  });
  if (options.dictionarySize !== DEFAULT_DICTIONARY_SIZE) {
    throw new CacheDictionaryOperatorError(
      `--dictionary-size is fixed at ${DEFAULT_DICTIONARY_SIZE} bytes to match the runtime`,
    );
  }
  options.scanCount = positiveInteger(options.scanCount, '--scan-count', { maximum: 100_000 });
  options.pttlBatchSize = positiveInteger(options.pttlBatchSize, '--pttl-batch-size', {
    maximum: 1_000,
  });

  if (options.compressionLevel !== DEFAULT_ZSTD_COMPRESSION_LEVEL) {
    throw new CacheDictionaryOperatorError(
      `Compression level is fixed at ${DEFAULT_ZSTD_COMPRESSION_LEVEL}`,
    );
  }
  if (!SECRET_NAME_RE.test(options.secret)) {
    throw new CacheDictionaryOperatorError('--secret is not a valid Secret Manager secret name');
  }
  if (options.upload && !options.project) {
    throw new CacheDictionaryOperatorError('--project is required with --upload');
  }
  if (options.project && !PROJECT_ID_RE.test(options.project)) {
    throw new CacheDictionaryOperatorError('--project is not a valid Google Cloud project identifier');
  }

  return options;
}

export const HELP_TEXT = `Usage: node scripts/cache-zstd-dictionary.mjs [options]

Read-only by default. Samples the newest analysis:* entries by PTTL, trains a
private 32 KiB FastCover dictionary, and benchmarks held-out recent entries.

Options:
  --upload                 Upload the validated dictionary as a new secret version
  --project ID             Google Cloud project (required with --upload)
  --secret NAME            Secret name (default: ${DEFAULT_SECRET_NAME})
  --dictionary PATH        Existing dictionary source; repeat for rotations
  --train-count N          Training entries (default: ${DEFAULT_TRAIN_COUNT})
  --holdout-count N        Newest held-out entries (default: ${DEFAULT_HOLDOUT_COUNT})
  --dictionary-size N      Fixed dictionary bytes (must be ${DEFAULT_DICTIONARY_SIZE})
  --scan-count N           Redis SCAN count hint (default: ${DEFAULT_SCAN_COUNT})
  --pttl-batch-size N      PTTL pipeline batch size (default: ${DEFAULT_PTTL_BATCH_SIZE})
  --zstd PATH              zstd executable (default: zstd)
  --gcloud PATH            gcloud executable (default: gcloud)
  -h, --help               Show this help

Credentials are read only from UPSTASH_REDIS_REST_URL and
UPSTASH_REDIS_REST_TOKEN; do not pass credentials on the command line.`;

function asBuffer(value, label) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new CacheDictionaryOperatorError(`${label} must be binary data`);
}

function assertDictionary(dictionary, label = 'Dictionary') {
  const bytes = asBuffer(dictionary, label);
  if (bytes.length === 0 || bytes.length > MAX_DICTIONARY_SOURCE_BYTES) {
    throw new CacheDictionaryOperatorError(
      `${label} must contain between 1 and ${MAX_DICTIONARY_SOURCE_BYTES} bytes`,
    );
  }
  return bytes;
}

/** Construct the exact compact binary envelope emitted by cacheCodec.js. */
export function buildBinaryEnvelope(dictionaryId, frame) {
  if (!DICTIONARY_ID_RE.test(dictionaryId)) {
    throw new CacheDictionaryOperatorError('Dictionary ID must be a lowercase SHA-256 digest');
  }
  const frameBytes = asBuffer(frame, 'Zstandard frame');
  const envelope = Buffer.allocUnsafe(ZSTD_ENVELOPE_HEADER_BYTES + frameBytes.length);
  envelope.write(ZSTD_ENVELOPE_MAGIC, 0, 'ascii');
  envelope[Buffer.byteLength(ZSTD_ENVELOPE_MAGIC, 'ascii')] = ZSTD_ENVELOPE_VERSION;
  Buffer.from(dictionaryId, 'hex').copy(
    envelope,
    Buffer.byteLength(ZSTD_ENVELOPE_MAGIC, 'ascii') + 1,
  );
  frameBytes.copy(envelope, ZSTD_ENVELOPE_HEADER_BYTES);
  return envelope;
}

function zstdOptions(level, dictionary) {
  return {
    ...(dictionary ? { dictionary } : {}),
    params: {
      [zlibConstants.ZSTD_c_compressionLevel]: level,
    },
  };
}

function ensureAnalysisObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CacheDictionaryOperatorError('Cache sample is not an analysis object');
  }
  return value;
}

function parseJsonBytes(bytes) {
  if (bytes.length > MAX_ANALYSIS_CACHE_BYTES) {
    throw new CacheDictionaryOperatorError('Cache sample exceeds the uncompressed size limit');
  }
  let text;
  try {
    text = utf8Decoder.decode(bytes);
  } catch (error) {
    throw new CacheDictionaryOperatorError('Cache sample is not valid UTF-8', { cause: error });
  }
  try {
    return ensureAnalysisObject(JSON.parse(text));
  } catch (error) {
    if (error instanceof CacheDictionaryOperatorError) throw error;
    throw new CacheDictionaryOperatorError('Cache sample is not valid JSON', { cause: error });
  }
}

/** Decode raw legacy JSON or the current compact binary cache envelope. */
export async function decodeStoredAnalysisValue(value, { resolveDictionary } = {}) {
  const stored = asBuffer(value, 'Stored cache value');
  if (!isZstdEnvelope(stored)) {
    const parsed = parseJsonBytes(stored);
    return { jsonBytes: stored, value: parsed, compressed: false, dictionaryId: null };
  }

  if (typeof resolveDictionary !== 'function') {
    throw new CacheDictionaryOperatorError('No dictionary resolver is available');
  }
  let dictionaryId;
  try {
    dictionaryId = getEnvelopeDictionaryId(stored);
  } catch (error) {
    throw new CacheDictionaryOperatorError('Compressed cache sample has an invalid envelope', {
      cause: error,
    });
  }
  const dictionaryValue = await resolveDictionary(dictionaryId);
  if (!dictionaryValue) {
    throw new CacheDictionaryOperatorError('Compressed cache sample uses an unavailable dictionary');
  }
  const dictionary = assertDictionary(dictionaryValue, 'Resolved dictionary');
  if (getDictionaryId(dictionary) !== dictionaryId) {
    throw new CacheDictionaryOperatorError('Resolved dictionary hash does not match the envelope');
  }

  let jsonBytes;
  try {
    jsonBytes = zstdDecompressSync(stored.subarray(ZSTD_ENVELOPE_HEADER_BYTES), {
      dictionary,
      maxOutputLength: MAX_ANALYSIS_CACHE_BYTES,
    });
  } catch (error) {
    throw new CacheDictionaryOperatorError('Compressed cache sample could not be decoded', {
      cause: error,
    });
  }
  const parsed = parseJsonBytes(jsonBytes);
  return { jsonBytes, value: parsed, compressed: true, dictionaryId };
}

export async function loadDictionaryFiles(paths) {
  const dictionaries = [];
  for (const dictionaryPath of paths) {
    let fileStats;
    try {
      fileStats = await stat(dictionaryPath);
    } catch (error) {
      throw new CacheDictionaryOperatorError(
        `Unable to read dictionary source ${basename(dictionaryPath)}`,
        { cause: error },
      );
    }
    if (!fileStats.isFile() || fileStats.size <= 0 || fileStats.size > MAX_DICTIONARY_SOURCE_BYTES) {
      throw new CacheDictionaryOperatorError(
        `Dictionary source ${basename(dictionaryPath)} has an invalid size`,
      );
    }
    const bytes = assertDictionary(await readFile(dictionaryPath), 'Dictionary source');
    dictionaries.push({ id: getDictionaryId(bytes), bytes });
  }
  return dictionaries;
}

/** Resolve dictionaries from mounted/local files, then the private Redis registry. */
export function createDictionaryResolver({ dictionaries = [], binaryClient } = {}) {
  const known = new Map();
  for (const dictionary of dictionaries) {
    const bytes = assertDictionary(dictionary.bytes ?? dictionary, 'Dictionary source');
    const id = dictionary.id ?? getDictionaryId(bytes);
    if (!DICTIONARY_ID_RE.test(id) || getDictionaryId(bytes) !== id) {
      throw new CacheDictionaryOperatorError('Dictionary source hash does not match its bytes');
    }
    known.set(id, bytes);
  }
  const pending = new Map();

  return async function resolveDictionary(dictionaryId) {
    if (!DICTIONARY_ID_RE.test(dictionaryId)) return null;
    if (known.has(dictionaryId)) return known.get(dictionaryId);
    if (!binaryClient || typeof binaryClient.get !== 'function') return null;
    if (pending.has(dictionaryId)) return pending.get(dictionaryId);

    const request = (async () => {
      let value;
      try {
        value = await binaryClient.get(`${DICTIONARY_REGISTRY_PREFIX}${dictionaryId}`);
      } catch (error) {
        throw new CacheDictionaryOperatorError('Unable to read the Redis dictionary registry', {
          cause: error,
        });
      }
      if (!value) return null;
      const bytes = assertDictionary(value, 'Registered dictionary');
      if (getDictionaryId(bytes) !== dictionaryId) {
        throw new CacheDictionaryOperatorError('Registered dictionary failed SHA-256 verification');
      }
      known.set(dictionaryId, bytes);
      return bytes;
    })();
    pending.set(dictionaryId, request);
    try {
      return await request;
    } finally {
      pending.delete(dictionaryId);
    }
  };
}

export async function scanAnalysisKeys(redis, { count = DEFAULT_SCAN_COUNT } = {}) {
  if (!redis || typeof redis.scan !== 'function') {
    throw new TypeError('A Redis client with scan() is required');
  }
  const keys = new Set();
  let cursor = '0';
  let iterations = 0;
  try {
    do {
      const result = await redis.scan(cursor, { match: 'analysis:*', count });
      if (!Array.isArray(result) || result.length !== 2 || !Array.isArray(result[1])) {
        throw new Error('invalid SCAN response');
      }
      cursor = String(result[0]);
      for (const key of result[1]) {
        if (typeof key === 'string' && key.startsWith('analysis:')) keys.add(key);
      }
      iterations += 1;
      if (iterations > 1_000_000) throw new Error('SCAN did not terminate');
    } while (cursor !== '0');
  } catch (error) {
    throw new CacheDictionaryOperatorError('Unable to scan Redis analysis keys', { cause: error });
  }
  return [...keys];
}

async function pttlBatch(redis, keys) {
  if (typeof redis.pipeline === 'function') {
    const pipeline = redis.pipeline();
    for (const key of keys) pipeline.pttl(key);
    return pipeline.exec();
  }
  return Promise.all(keys.map(key => redis.pttl(key)));
}

/** Rank expiring cache keys newest-first; a larger PTTL means a newer write. */
export async function rankKeysByPttl(
  redis,
  keys,
  { batchSize = DEFAULT_PTTL_BATCH_SIZE } = {},
) {
  const ranked = [];
  try {
    for (let offset = 0; offset < keys.length; offset += batchSize) {
      const batch = keys.slice(offset, offset + batchSize);
      const pttls = await pttlBatch(redis, batch);
      if (!Array.isArray(pttls) || pttls.length !== batch.length) {
        throw new Error('invalid PTTL response');
      }
      for (let index = 0; index < batch.length; index += 1) {
        const pttl = Number(pttls[index]);
        // -1 is persistent and cannot be freshness-ranked; -2 is already gone.
        if (Number.isFinite(pttl) && pttl >= 0) {
          ranked.push({ key: batch[index], pttl, order: offset + index });
        }
      }
    }
  } catch (error) {
    throw new CacheDictionaryOperatorError('Unable to rank Redis analysis keys by PTTL', {
      cause: error,
    });
  }
  ranked.sort((left, right) => right.pttl - left.pttl || left.order - right.order);
  return ranked.map(({ key, pttl }) => ({ key, pttl }));
}

/** Read the newest decodable samples without ever printing cache keys or values. */
export async function collectNewestSamples({
  redis,
  binaryClient,
  resolveDictionary,
  sampleCount,
  scanCount = DEFAULT_SCAN_COUNT,
  pttlBatchSize = DEFAULT_PTTL_BATCH_SIZE,
}) {
  if (!binaryClient || typeof binaryClient.get !== 'function') {
    throw new TypeError('A binary Redis client with get() is required');
  }
  const required = positiveInteger(sampleCount, 'sampleCount', { maximum: 20_000 });
  const keys = await scanAnalysisKeys(redis, { count: scanCount });
  const ranked = await rankKeysByPttl(redis, keys, { batchSize: pttlBatchSize });
  const samples = [];
  let skipped = 0;

  for (const { key } of ranked) {
    if (samples.length >= required) break;
    try {
      const stored = await binaryClient.get(key);
      if (!stored) {
        skipped += 1;
        continue;
      }
      const decoded = await decodeStoredAnalysisValue(stored, { resolveDictionary });
      samples.push(decoded.jsonBytes);
    } catch {
      // A corrupt, expired, or unknown-dictionary entry is unusable training
      // input. Keep aggregate counts only; never expose its key or contents.
      skipped += 1;
    }
  }

  if (samples.length < required) {
    throw new CacheDictionaryOperatorError(
      `Only ${samples.length} of ${required} required recent analysis samples could be decoded ` +
      `(${skipped} skipped)`,
    );
  }
  return {
    samples,
    stats: {
      scannedKeys: keys.length,
      expiringKeys: ranked.length,
      decodedSamples: samples.length,
      skippedSamples: skipped,
    },
  };
}

/** Hold out the newest entries and train on the next-newest entries. */
export function splitRecentSamples(samples, { trainCount, holdoutCount }) {
  const required = trainCount + holdoutCount;
  if (!Array.isArray(samples) || samples.length < required) {
    throw new CacheDictionaryOperatorError(`${required} samples are required for the split`);
  }
  return {
    holdoutSamples: samples.slice(0, holdoutCount),
    trainingSamples: samples.slice(holdoutCount, required),
  };
}

async function invokeExecFile(executable, args, options = {}) {
  return execFile(executable, args, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    ...options,
  });
}

export async function withSecureTemporaryDirectory(callback, {
  prefix = 'bsod-zstd-dictionary-',
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    await chmod(directory, 0o700);
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Train a FastCover dictionary without retaining samples or the dictionary on disk. */
export async function trainFastCoverDictionary(
  trainingSamples,
  {
    dictionarySize = DEFAULT_DICTIONARY_SIZE,
    zstdPath = 'zstd',
    runCommand = invokeExecFile,
  } = {},
) {
  if (!Array.isArray(trainingSamples) || trainingSamples.length < 5) {
    throw new CacheDictionaryOperatorError('At least five training samples are required');
  }
  const maxDictionaryBytes = positiveInteger(dictionarySize, 'dictionarySize', {
    maximum: MAX_DICTIONARY_SOURCE_BYTES,
  });
  if (maxDictionaryBytes !== DEFAULT_DICTIONARY_SIZE) {
    throw new CacheDictionaryOperatorError(
      `Dictionary size is fixed at ${DEFAULT_DICTIONARY_SIZE} bytes to match the runtime`,
    );
  }

  return withSecureTemporaryDirectory(async directory => {
    const sampleNames = [];
    for (let index = 0; index < trainingSamples.length; index += 1) {
      const sample = asBuffer(trainingSamples[index], 'Training sample');
      const name = `sample-${String(index).padStart(5, '0')}.json`;
      await writeFile(join(directory, name), sample, { flag: 'wx', mode: 0o600 });
      sampleNames.push(name);
    }

    const outputName = 'dictionary.zstd';
    try {
      await runCommand(
        zstdPath,
        [
          '--train-fastcover',
          `--maxdict=${maxDictionaryBytes}`,
          '-q',
          '-o',
          outputName,
          '--',
          ...sampleNames,
        ],
        { cwd: directory },
      );
    } catch (error) {
      throw new CacheDictionaryOperatorError(
        'Zstandard FastCover dictionary training failed',
        { cause: error },
      );
    }

    let dictionary;
    try {
      const outputPath = join(directory, outputName);
      // zstd inherits the operator's umask; tighten the generated artifact
      // explicitly even though its parent directory is already mode 0700.
      await chmod(outputPath, 0o600);
      dictionary = await readFile(outputPath);
    } catch (error) {
      throw new CacheDictionaryOperatorError(
        'Zstandard training did not produce a dictionary',
        { cause: error },
      );
    }
    if (dictionary.length !== maxDictionaryBytes) {
      throw new CacheDictionaryOperatorError(
        `Zstandard dictionary must be exactly ${maxDictionaryBytes} bytes`,
      );
    }
    return Buffer.from(dictionary);
  });
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

/** Benchmark level-3 frames and the exact production binary envelope. */
export function benchmarkDictionary(
  holdoutSamples,
  dictionaryValue,
  { compressionLevel = DEFAULT_ZSTD_COMPRESSION_LEVEL } = {},
) {
  if (!Array.isArray(holdoutSamples) || holdoutSamples.length === 0) {
    throw new CacheDictionaryOperatorError('At least one holdout sample is required');
  }
  if (compressionLevel !== DEFAULT_ZSTD_COMPRESSION_LEVEL) {
    throw new CacheDictionaryOperatorError(
      `Benchmark compression level must be ${DEFAULT_ZSTD_COMPRESSION_LEVEL}`,
    );
  }
  const dictionary = assertDictionary(dictionaryValue);
  if (dictionary.length !== DEFAULT_DICTIONARY_SIZE) {
    throw new CacheDictionaryOperatorError(
      `Dictionary must be exactly ${DEFAULT_DICTIONARY_SIZE} bytes to match the runtime`,
    );
  }
  const dictionaryId = getDictionaryId(dictionary);
  const totals = {
    samples: holdoutSamples.length,
    rawBytes: 0,
    dictionarylessFrameBytes: 0,
    dictionaryFrameBytes: 0,
    envelopeBytes: 0,
    selectedStorageBytes: 0,
    compressedEntries: 0,
  };

  for (const sampleValue of holdoutSamples) {
    const sample = asBuffer(sampleValue, 'Holdout sample');
    if (sample.length > MAX_ANALYSIS_CACHE_BYTES) {
      throw new CacheDictionaryOperatorError('Holdout sample exceeds the cache size limit');
    }
    // Refuse to benchmark opaque data. This also proves the training corpus did
    // not accidentally include cache envelopes or malformed values.
    parseJsonBytes(sample);

    let dictionarylessFrame;
    let dictionaryFrame;
    try {
      dictionarylessFrame = zstdCompressSync(
        sample,
        zstdOptions(compressionLevel),
      );
      dictionaryFrame = zstdCompressSync(
        sample,
        zstdOptions(compressionLevel, dictionary),
      );
    } catch (error) {
      throw new CacheDictionaryOperatorError('Zstandard benchmark compression failed', {
        cause: error,
      });
    }

    const envelope = buildBinaryEnvelope(dictionaryId, dictionaryFrame);
    let plainRoundTrip;
    let dictionaryRoundTrip;
    try {
      plainRoundTrip = zstdDecompressSync(dictionarylessFrame, {
        maxOutputLength: MAX_ANALYSIS_CACHE_BYTES,
      });
      dictionaryRoundTrip = zstdDecompressSync(dictionaryFrame, {
        dictionary,
        maxOutputLength: MAX_ANALYSIS_CACHE_BYTES,
      });
    } catch (error) {
      throw new CacheDictionaryOperatorError('Zstandard benchmark decompression failed', {
        cause: error,
      });
    }
    if (!plainRoundTrip.equals(sample) || !dictionaryRoundTrip.equals(sample)) {
      throw new CacheDictionaryOperatorError('Zstandard benchmark round-trip validation failed');
    }

    totals.rawBytes += sample.length;
    totals.dictionarylessFrameBytes += dictionarylessFrame.length;
    totals.dictionaryFrameBytes += dictionaryFrame.length;
    totals.envelopeBytes += envelope.length;
    totals.selectedStorageBytes += Math.min(sample.length, envelope.length);
    if (envelope.length < sample.length) totals.compressedEntries += 1;
  }

  return {
    ...totals,
    dictionaryId,
    dictionaryBytes: dictionary.length,
    dictionarylessRatio: ratio(totals.dictionarylessFrameBytes, totals.rawBytes),
    dictionaryFrameRatio: ratio(totals.dictionaryFrameBytes, totals.rawBytes),
    envelopeRatio: ratio(totals.envelopeBytes, totals.rawBytes),
    selectedStorageRatio: ratio(totals.selectedStorageBytes, totals.rawBytes),
  };
}

export function validateBenchmark(benchmark) {
  if (!benchmark || benchmark.samples <= 0 || benchmark.rawBytes <= 0) {
    throw new CacheDictionaryOperatorError('Benchmark did not contain usable holdout data');
  }
  if (benchmark.dictionaryFrameBytes >= benchmark.dictionarylessFrameBytes) {
    throw new CacheDictionaryOperatorError(
      'Dictionary did not improve held-out compression over dictionaryless Zstandard',
    );
  }
  if (benchmark.selectedStorageBytes >= benchmark.rawBytes || benchmark.compressedEntries === 0) {
    throw new CacheDictionaryOperatorError(
      'Dictionary did not reduce final held-out Redis storage',
    );
  }
  return true;
}

function extractSecretVersion(output) {
  const text = String(output || '').trim();
  if (/^[1-9]\d*$/.test(text)) return text;
  const matches = [...text.matchAll(/(?:\/versions\/|version\s*\[)([1-9]\d*)\]?/gi)];
  return matches.length > 0 ? matches[matches.length - 1][1] : null;
}

/** Upload exact dictionary bytes as one immutable Secret Manager version. */
export async function uploadDictionaryVersion(
  dictionaryValue,
  {
    project,
    secret = DEFAULT_SECRET_NAME,
    gcloudPath = 'gcloud',
    runCommand = invokeExecFile,
  },
) {
  if (!PROJECT_ID_RE.test(project || '')) {
    throw new CacheDictionaryOperatorError('A valid project is required for upload');
  }
  if (!SECRET_NAME_RE.test(secret)) {
    throw new CacheDictionaryOperatorError('A valid Secret Manager secret name is required');
  }
  const dictionary = assertDictionary(dictionaryValue);
  if (dictionary.length !== DEFAULT_DICTIONARY_SIZE) {
    throw new CacheDictionaryOperatorError(
      `Dictionary must be exactly ${DEFAULT_DICTIONARY_SIZE} bytes to match the runtime`,
    );
  }

  return withSecureTemporaryDirectory(async directory => {
    const dictionaryPath = join(directory, 'dictionary.zstd');
    await writeFile(dictionaryPath, dictionary, { flag: 'wx', mode: 0o600 });
    let result;
    try {
      result = await runCommand(
        gcloudPath,
        [
          'secrets',
          'versions',
          'add',
          secret,
          `--project=${project}`,
          `--data-file=${dictionaryPath}`,
          '--format=value(name)',
          '--quiet',
        ],
      );
    } catch (error) {
      throw new CacheDictionaryOperatorError(
        'Secret Manager dictionary upload failed; verify the secret exists and access is granted',
        { cause: error },
      );
    }
    const version = extractSecretVersion(`${result?.stdout || ''}\n${result?.stderr || ''}`);
    if (!version) {
      throw new CacheDictionaryOperatorError(
        'Secret Manager accepted the upload but did not return a numeric version',
      );
    }
    return { version, dictionaryId: getDictionaryId(dictionary), secret, project };
  });
}

function formatBytes(value) {
  return `${value.toLocaleString('en-US')} B`;
}

function percent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

export function formatBenchmarkReport({ selection, trainingSamples, holdoutSamples, benchmark }) {
  return [
    'Analysis-cache Zstandard dictionary benchmark',
    `  Redis analysis keys scanned: ${selection.scannedKeys}`,
    `  Expiring keys ranked: ${selection.expiringKeys}`,
    `  Recent samples decoded: ${selection.decodedSamples}`,
    `  Unusable recent entries skipped: ${selection.skippedSamples}`,
    `  Training samples: ${trainingSamples}`,
    `  Newest held-out samples: ${holdoutSamples}`,
    `  Dictionary: ${formatBytes(benchmark.dictionaryBytes)}`,
    `  Dictionary SHA-256: ${benchmark.dictionaryId}`,
    `  Holdout raw JSON: ${formatBytes(benchmark.rawBytes)} (100.00%)`,
    `  Dictionaryless zstd level 3 frames: ${formatBytes(benchmark.dictionarylessFrameBytes)} (${percent(benchmark.dictionarylessRatio)})`,
    `  Dictionary zstd level 3 frames: ${formatBytes(benchmark.dictionaryFrameBytes)} (${percent(benchmark.dictionaryFrameRatio)})`,
    `  Final binary envelopes: ${formatBytes(benchmark.envelopeBytes)} (${percent(benchmark.envelopeRatio)})`,
    `  Production size-fallback storage: ${formatBytes(benchmark.selectedStorageBytes)} (${percent(benchmark.selectedStorageRatio)})`,
    `  Entries stored compressed: ${benchmark.compressedEntries}/${benchmark.samples}`,
  ].join('\n');
}

function effectiveDictionaryPaths(options, env) {
  const paths = [...options.dictionaryPaths];
  const mounted = env.CACHE_ZSTD_DICTIONARY_PATH;
  if (mounted && !paths.includes(mounted)) paths.push(mounted);
  return paths;
}

export async function runOperator(options, {
  env = process.env,
  log = console.log,
  RedisClass = Redis,
  binaryClientFactory = createUpstashBinaryClient,
  trainDictionary = trainFastCoverDictionary,
  uploadDictionary = uploadDictionaryVersion,
} = {}) {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new CacheDictionaryOperatorError(
      'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required',
    );
  }

  const redis = new RedisClass({
    url,
    token,
    automaticDeserialization: false,
    responseEncoding: false,
  });
  const binaryClient = binaryClientFactory({ url, token });
  const dictionarySources = await loadDictionaryFiles(effectiveDictionaryPaths(options, env));
  const resolveDictionary = createDictionaryResolver({
    dictionaries: dictionarySources,
    binaryClient,
  });
  const sampleCount = options.trainCount + options.holdoutCount;
  const collected = await collectNewestSamples({
    redis,
    binaryClient,
    resolveDictionary,
    sampleCount,
    scanCount: options.scanCount,
    pttlBatchSize: options.pttlBatchSize,
  });
  const { trainingSamples, holdoutSamples } = splitRecentSamples(collected.samples, options);
  const dictionary = await trainDictionary(trainingSamples, {
    dictionarySize: options.dictionarySize,
    zstdPath: options.zstdPath,
  });
  const benchmark = benchmarkDictionary(holdoutSamples, dictionary, {
    compressionLevel: options.compressionLevel,
  });
  validateBenchmark(benchmark);

  log(formatBenchmarkReport({
    selection: collected.stats,
    trainingSamples: trainingSamples.length,
    holdoutSamples: holdoutSamples.length,
    benchmark,
  }));

  let upload = null;
  if (options.upload) {
    upload = await uploadDictionary(dictionary, {
      project: options.project,
      secret: options.secret,
      gcloudPath: options.gcloudPath,
    });
    if (!/^[1-9]\d*$/.test(upload.version) || upload.dictionaryId !== benchmark.dictionaryId) {
      throw new CacheDictionaryOperatorError('Uploaded secret version failed result validation');
    }
    log(
      `Uploaded ${upload.secret} version ${upload.version} in ${upload.project} ` +
      `(SHA-256 ${upload.dictionaryId})`,
    );
  } else {
    log('Dry run complete; no dictionary was uploaded or retained on disk.');
  }

  return { selection: collected.stats, benchmark, upload };
}

export async function main(argv = process.argv.slice(2), dependencies) {
  const options = parseArguments(argv);
  if (options.help) {
    (dependencies?.log ?? console.log)(HELP_TEXT);
    return null;
  }
  return runOperator(options, dependencies);
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entrypoint === import.meta.url) {
  main().catch(error => {
    const message = error instanceof CacheDictionaryOperatorError
      ? error.message
      : 'Unexpected cache dictionary operator failure';
    console.error(`[cache-zstd-dictionary] ${message}`);
    process.exitCode = 1;
  });
}
