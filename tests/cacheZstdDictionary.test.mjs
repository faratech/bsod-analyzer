import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, stat, writeFile } from 'node:fs/promises';
import {
  constants as zlibConstants,
  zstdCompressSync,
} from 'node:zlib';

import {
  CacheDictionaryOperatorError,
  DEFAULT_DICTIONARY_SIZE,
  DEFAULT_HOLDOUT_COUNT,
  DEFAULT_SECRET_NAME,
  DEFAULT_TRAIN_COUNT,
  DICTIONARY_REGISTRY_PREFIX,
  benchmarkDictionary,
  buildBinaryEnvelope,
  collectNewestSamples,
  createDictionaryResolver,
  decodeStoredAnalysisValue,
  formatBenchmarkReport,
  parseArguments,
  rankKeysByPttl,
  splitRecentSamples,
  trainFastCoverDictionary,
  uploadDictionaryVersion,
  validateBenchmark,
  withSecureTemporaryDirectory,
} from '../scripts/cache-zstd-dictionary.mjs';
import {
  ZSTD_ENVELOPE_HEADER_BYTES,
  getDictionaryId,
  getEnvelopeDictionaryId,
  isZstdEnvelope,
} from '../services/cacheCodec.js';

const DICTIONARY_PHRASE = Buffer.from(
  'BUGCHECK_CODE MODULE_NAME IMAGE_NAME STACK_TEXT FAILURE_BUCKET_ID ' +
  'PROCESS_NAME SYMBOL_NAME analysisSignalText structured aiReport recommendations ',
);
const DICTIONARY = Buffer.alloc(DEFAULT_DICTIONARY_SIZE);
for (let offset = 0; offset < DICTIONARY.length; offset += DICTIONARY_PHRASE.length) {
  DICTIONARY_PHRASE.copy(
    DICTIONARY,
    offset,
    0,
    Math.min(DICTIONARY_PHRASE.length, DICTIONARY.length - offset),
  );
}

function analysisBytes(index = 1) {
  return Buffer.from(JSON.stringify({
    windbgOutput: (
      `BUGCHECK_CODE: 0x133 MODULE_NAME: driver_${index} IMAGE_NAME: driver_${index}.sys ` +
      'STACK_TEXT: nt!KeBugCheckEx nt!KiUpdateRunTime FAILURE_BUCKET_ID: watchdog\n'
    ).repeat(200),
    analysisSignalText: `Probable driver fault ${index} — résumé 日本語`,
    structured: { bugcheck: 'DPC_WATCHDOG_VIOLATION', index },
    aiReport: { summary: `Update driver ${index}`, recommendations: ['Update'] },
  }));
}

test('argument parser defaults to a read-only 100/25 level-3 benchmark', () => {
  const defaults = parseArguments([]);
  assert.equal(defaults.upload, false);
  assert.equal(defaults.trainCount, DEFAULT_TRAIN_COUNT);
  assert.equal(defaults.holdoutCount, DEFAULT_HOLDOUT_COUNT);
  assert.equal(defaults.dictionarySize, DEFAULT_DICTIONARY_SIZE);
  assert.equal(defaults.compressionLevel, 3);
  assert.equal(defaults.secret, DEFAULT_SECRET_NAME);

  assert.throws(
    () => parseArguments(['--upload']),
    error => error instanceof CacheDictionaryOperatorError && /--project/.test(error.message),
  );
  assert.throws(
    () => parseArguments(['--token=do-not-print-this']),
    error => error instanceof CacheDictionaryOperatorError &&
      !error.message.includes('do-not-print-this'),
  );
  assert.throws(
    () => parseArguments(['--dictionary-size=16384']),
    error => error instanceof CacheDictionaryOperatorError && /fixed at 32768/.test(error.message),
  );
  const upload = parseArguments([
    '--upload',
    '--project=project-bigfoot',
    '--dictionary',
    '/private/old-dictionary',
    '--train-count=20',
    '--holdout-count',
    '5',
  ]);
  assert.equal(upload.upload, true);
  assert.equal(upload.project, 'project-bigfoot');
  assert.deepEqual(upload.dictionaryPaths, ['/private/old-dictionary']);
  assert.equal(upload.trainCount, 20);
  assert.equal(upload.holdoutCount, 5);
});

test('binary envelope helper matches the production codec layout', async () => {
  const dictionaryId = getDictionaryId(DICTIONARY);
  const raw = analysisBytes();
  const frame = zstdCompressSync(raw, {
    dictionary: DICTIONARY,
    params: { [zlibConstants.ZSTD_c_compressionLevel]: 3 },
  });
  const envelope = buildBinaryEnvelope(dictionaryId, frame);

  assert.equal(isZstdEnvelope(envelope), true);
  assert.equal(getEnvelopeDictionaryId(envelope), dictionaryId);
  assert.deepEqual(envelope.subarray(ZSTD_ENVELOPE_HEADER_BYTES), frame);

  const decoded = await decodeStoredAnalysisValue(envelope, {
    resolveDictionary: async requested => requested === dictionaryId ? DICTIONARY : null,
  });
  assert.equal(decoded.compressed, true);
  assert.equal(decoded.dictionaryId, dictionaryId);
  assert.deepEqual(decoded.jsonBytes, raw);
  assert.equal(decoded.value.structured.index, 1);
});

test('stored-value decoder preserves exact legacy JSON bytes and rejects bad sources', async () => {
  const raw = analysisBytes(2);
  const decoded = await decodeStoredAnalysisValue(raw);
  assert.equal(decoded.compressed, false);
  assert.strictEqual(decoded.jsonBytes, raw);

  await assert.rejects(
    decodeStoredAnalysisValue(Buffer.from('not json')),
    /not valid JSON/,
  );
  await assert.rejects(
    decodeStoredAnalysisValue(Buffer.from('[]')),
    /not an analysis object/,
  );
});

test('dictionary resolver verifies local and private Redis registry bytes', async () => {
  const localId = getDictionaryId(DICTIONARY);
  const historical = Buffer.from('historical dictionary bytes '.repeat(512));
  const historicalId = getDictionaryId(historical);
  const gets = [];
  const resolver = createDictionaryResolver({
    dictionaries: [{ id: localId, bytes: DICTIONARY }],
    binaryClient: {
      async get(key) {
        gets.push(key);
        return historical;
      },
    },
  });

  assert.strictEqual(await resolver(localId), DICTIONARY);
  assert.deepEqual(await resolver(historicalId), historical);
  assert.deepEqual(await resolver(historicalId), historical);
  assert.deepEqual(gets, [`${DICTIONARY_REGISTRY_PREFIX}${historicalId}`]);

  const invalid = createDictionaryResolver({
    binaryClient: { get: async () => Buffer.from('wrong') },
  });
  await assert.rejects(invalid(historicalId), /SHA-256 verification/);
});

test('PTTL ranking is newest-first and excludes persistent or expired keys', async () => {
  const ttlByKey = new Map([
    ['analysis:old', 100],
    ['analysis:new', 900],
    ['analysis:persistent', -1],
    ['analysis:gone', -2],
    ['analysis:middle', 500],
  ]);
  const redis = {
    pipeline() {
      const keys = [];
      return {
        pttl(key) { keys.push(key); return this; },
        async exec() { return keys.map(key => ttlByKey.get(key)); },
      };
    },
  };
  const ranked = await rankKeysByPttl(redis, [...ttlByKey.keys()], { batchSize: 2 });
  assert.deepEqual(ranked, [
    { key: 'analysis:new', pttl: 900 },
    { key: 'analysis:middle', pttl: 500 },
    { key: 'analysis:old', pttl: 100 },
  ]);
});

test('newest sample collection skips corrupt values without exposing identifiers', async () => {
  const values = new Map([
    ['analysis:newest', analysisBytes(1)],
    ['analysis:corrupt-secret-key', Buffer.from('private crash contents')],
    ['analysis:next', analysisBytes(2)],
    ['analysis:oldest', analysisBytes(3)],
  ]);
  const ttls = new Map([
    ['analysis:newest', 400],
    ['analysis:corrupt-secret-key', 350],
    ['analysis:next', 300],
    ['analysis:oldest', 200],
  ]);
  const redis = {
    async scan() { return ['0', [...values.keys()]]; },
    async pttl(key) { return ttls.get(key); },
  };
  const collected = await collectNewestSamples({
    redis,
    binaryClient: { get: async key => values.get(key) },
    resolveDictionary: async () => null,
    sampleCount: 3,
  });

  assert.deepEqual(
    collected.samples.map(bytes => JSON.parse(bytes).structured.index),
    [1, 2, 3],
  );
  assert.deepEqual(collected.stats, {
    scannedKeys: 4,
    expiringKeys: 4,
    decodedSamples: 3,
    skippedSamples: 1,
  });
  assert.equal(JSON.stringify(collected.stats).includes('corrupt-secret-key'), false);
  assert.equal(JSON.stringify(collected.stats).includes('private crash contents'), false);
});

test('sample split holds out the newest entries and trains on the remainder', () => {
  const samples = [1, 2, 3, 4, 5].map(value => Buffer.from(String(value)));
  const split = splitRecentSamples(samples, { trainCount: 3, holdoutCount: 2 });
  assert.deepEqual(split.holdoutSamples.map(String), ['1', '2']);
  assert.deepEqual(split.trainingSamples.map(String), ['3', '4', '5']);
});

test('FastCover training uses private generic files and always cleans its directory', async () => {
  const training = Array.from({ length: 6 }, (_, index) => analysisBytes(index));
  let temporaryDirectory;
  const trained = Buffer.from(DICTIONARY);
  const result = await trainFastCoverDictionary(training, {
    dictionarySize: 32 * 1024,
    runCommand: async (command, args, options) => {
      assert.equal(command, 'zstd');
      assert.ok(args.includes('--train-fastcover'));
      assert.ok(args.includes('--maxdict=32768'));
      assert.equal(args.some(value => value.includes('analysis:')), false);
      temporaryDirectory = options.cwd;
      assert.equal((await stat(temporaryDirectory)).mode & 0o777, 0o700);
      const firstSample = `${temporaryDirectory}/sample-00000.json`;
      assert.equal((await stat(firstSample)).mode & 0o777, 0o600);
      assert.deepEqual(await readFile(firstSample), training[0]);
      await writeFile(`${temporaryDirectory}/dictionary.zstd`, trained, { mode: 0o600 });
      return { stdout: '', stderr: '' };
    },
  });

  assert.deepEqual(result, trained);
  await assert.rejects(access(temporaryDirectory));
});

test('secure temporary directories are deleted when work fails', async () => {
  let directory;
  await assert.rejects(
    withSecureTemporaryDirectory(async value => {
      directory = value;
      throw new Error('sentinel');
    }),
    /sentinel/,
  );
  await assert.rejects(access(directory));
});

test('held-out benchmark validates round trips and exact envelope overhead', () => {
  const holdout = [analysisBytes(10), analysisBytes(11), analysisBytes(12)];
  const benchmark = benchmarkDictionary(holdout, DICTIONARY);

  assert.equal(benchmark.samples, 3);
  assert.equal(
    benchmark.envelopeBytes - benchmark.dictionaryFrameBytes,
    ZSTD_ENVELOPE_HEADER_BYTES * holdout.length,
  );
  assert.ok(benchmark.dictionaryFrameBytes < benchmark.dictionarylessFrameBytes);
  assert.ok(benchmark.selectedStorageBytes < benchmark.rawBytes);
  assert.equal(validateBenchmark(benchmark), true);

  const report = formatBenchmarkReport({
    selection: { scannedKeys: 10, expiringKeys: 9, decodedSamples: 3, skippedSamples: 1 },
    trainingSamples: 100,
    holdoutSamples: 25,
    benchmark,
  });
  assert.match(report, /Final binary envelopes/);
  assert.match(report, /Dictionary SHA-256/);
  assert.equal(report.includes('analysis:'), false);
  assert.equal(report.includes('BUGCHECK_CODE'), false);
});

test('Secret Manager upload writes mode-0600 bytes and returns a numeric version', async () => {
  let temporaryDirectory;
  let capturedArgs;
  const result = await uploadDictionaryVersion(DICTIONARY, {
    project: 'project-bigfoot',
    runCommand: async (command, args) => {
      assert.equal(command, 'gcloud');
      capturedArgs = args;
      const dataArgument = args.find(value => value.startsWith('--data-file='));
      const dictionaryPath = dataArgument.slice('--data-file='.length);
      temporaryDirectory = dictionaryPath.slice(0, dictionaryPath.lastIndexOf('/'));
      assert.equal((await stat(dictionaryPath)).mode & 0o777, 0o600);
      assert.deepEqual(await readFile(dictionaryPath), DICTIONARY);
      return {
        stdout: 'projects/123/secrets/redis-zstd-dictionary/versions/17\n',
        stderr: '',
      };
    },
  });

  assert.equal(result.version, '17');
  assert.equal(result.dictionaryId, getDictionaryId(DICTIONARY));
  assert.ok(capturedArgs.includes('versions'));
  assert.ok(capturedArgs.includes('add'));
  assert.ok(capturedArgs.includes('--quiet'));
  await assert.rejects(access(temporaryDirectory));

  await assert.rejects(
    uploadDictionaryVersion(Buffer.alloc(16 * 1024), {
      project: 'project-bigfoot',
      runCommand: async () => assert.fail('wrong-sized dictionary must not reach gcloud'),
    }),
    /exactly 32768 bytes/,
  );
});
