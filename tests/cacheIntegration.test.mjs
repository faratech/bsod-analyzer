import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getCacheCompressionStatus,
  getCachedAnalysis,
  getRedisDisabledReason,
  initCache,
  initCacheCompression,
  isAnalysisCached,
  isCacheEnabled,
  setCachedAnalysis,
} from '../services/cache.js';
import { isZstdEnvelope } from '../services/cacheCodec.js';

function createFakeClients() {
  const values = new Map();
  const ttls = new Map();
  const events = [];

  const redisClient = {
    async ping() { return 'PONG'; },
    async exists(key) {
      events.push(['exists', key]);
      return values.has(key) ? 1 : 0;
    },
    async get(key) {
      events.push(['redis-get', key]);
      return values.get(key) ?? null;
    },
    async set(key, value, options = {}) {
      events.push(['redis-set', key]);
      if (options.nx && values.has(key)) return null;
      values.set(key, value);
      if (options.ex) ttls.set(key, options.ex);
      return 'OK';
    },
    async del(key) {
      values.delete(key);
      ttls.delete(key);
      return 1;
    },
    async incr(key) {
      return redisClient.incrby(key, 1);
    },
    async incrby(key, delta) {
      const next = Number(values.get(key) || 0) + delta;
      values.set(key, String(next));
      return next;
    },
    async expire(key, seconds) {
      ttls.set(key, seconds);
      return 1;
    },
    async ttl(key) {
      return ttls.has(key) ? ttls.get(key) : -1;
    },
  };

  const analysisClient = {
    async get(key) {
      events.push(['binary-get', key]);
      const value = values.get(key);
      return value === undefined ? null : Buffer.from(value);
    },
    async set(key, value, { ex } = {}) {
      events.push(['binary-set', key]);
      values.set(key, Buffer.from(value));
      if (ex) ttls.set(key, ex);
      return true;
    },
    async setNx(key, value) {
      events.push(['binary-setnx', key]);
      if (values.has(key)) return false;
      values.set(key, Buffer.from(value));
      return true;
    },
    async del(key) {
      events.push(['binary-del', key]);
      values.delete(key);
      ttls.delete(key);
      return true;
    },
  };

  return { redisClient, analysisClient, values, ttls, events };
}

function trainedDictionaryFixture() {
  const phrase = Buffer.from(
    'BUGCHECK_CODE MODULE_NAME IMAGE_NAME STACK_TEXT FAILURE_BUCKET_ID ' +
    'analysisSignalText structured aiReport recommendations\n',
  );
  const dictionary = Buffer.alloc(32 * 1024);
  for (let offset = 0; offset < dictionary.length; offset += phrase.length) {
    phrase.copy(dictionary, offset, 0, Math.min(phrase.length, dictionary.length - offset));
  }
  return dictionary;
}

test('cache service publishes dictionaries before zstd entries and merges model reports', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bsod-cache-integration-'));
  const dictionaryPath = join(directory, 'cache.zdict');
  await writeFile(dictionaryPath, trainedDictionaryFixture(), { mode: 0o600 });
  t.after(() => rm(directory, { recursive: true, force: true }));

  const fake = createFakeClients();
  initCache({ redisClient: fake.redisClient, analysisClient: fake.analysisClient });
  assert.equal(
    await initCacheCompression({
      dictionaryPath,
      writesEnabled: true,
      // Probe/verify on every publish so this test can exercise flush recovery
      // and integrity verification without waiting out the real windows.
      flushProbeMs: 0,
      refreshIntervalMs: 0,
    }),
    true,
  );
  assert.deepEqual(
    { ...getCacheCompressionStatus(), dictionaryId: Boolean(getCacheCompressionStatus().dictionaryId) },
    {
      dictionaryLoaded: true,
      dictionaryId: true,
      writesEnabled: true,
      transport: 'upstash-rest-binary',
    },
  );

  const dictionaryKey = [...fake.values.keys()].find(key => key.startsWith('cachemeta:zstd:dictionary:'));
  assert.ok(dictionaryKey);
  assert.equal(fake.values.get(dictionaryKey).length, 32 * 1024);

  // Simulate the user-owned whole database flush. The next compressed write
  // must restore the dictionary registry before publishing its envelope.
  fake.values.clear();
  fake.ttls.clear();
  fake.events.length = 0;

  const hash = '0123456789abcdef';
  const windbgOutput = (
    'BUGCHECK_CODE: 133\nMODULE_NAME: driver\nSTACK_TEXT: nt!KeBugCheckEx\n'
  ).repeat(4_000);
  assert.equal(await setCachedAnalysis(hash, {
    windbgOutput,
    structured: { bugcheck: 'DPC_WATCHDOG_VIOLATION' },
    aiReport: { summary: 'first model' },
    aiModel: 'model-a',
  }), true);

  const analysisKey = `analysis:${hash}`;
  assert.equal(isZstdEnvelope(fake.values.get(analysisKey)), true);
  assert.equal(fake.ttls.get(analysisKey), 7 * 24 * 60 * 60);
  const registryWrite = fake.events.findIndex(([operation]) => operation === 'binary-setnx');
  const analysisWrite = fake.events.findIndex(
    ([operation, key]) => operation === 'binary-set' && key === analysisKey,
  );
  assert.ok(registryWrite >= 0 && analysisWrite > registryWrite);

  assert.equal(await setCachedAnalysis(hash, {
    aiReport: { summary: 'second model' },
    aiModel: 'model-b',
  }), true);
  const merged = await getCachedAnalysis(hash);
  assert.equal(merged.windbgOutput, windbgOutput);
  assert.equal(merged.aiReports['model-a'].summary, 'first model');
  assert.equal(merged.aiReports['model-b'].summary, 'second model');

  // A malformed cache value is disposable and is repaired by the next write.
  fake.values.set(analysisKey, Buffer.from('BSODZSTD\x01'));
  assert.equal(await setCachedAnalysis(hash, { windbgOutput: 'replacement' }), true);
  assert.equal((await getCachedAnalysis(hash)).windbgOutput, 'replacement');
});

test('a cache write is one read plus one write, and existence checks never download values', async () => {
  const fake = createFakeClients();
  initCache({ redisClient: fake.redisClient, analysisClient: fake.analysisClient });
  await initCacheCompression({ dictionaryPath: '/nonexistent/dictionary', writesEnabled: false });

  const hash = '1111222233334444';
  fake.events.length = 0;
  assert.equal(await setCachedAnalysis(hash, { windbgOutput: 'BUGCHECK_CODE: 7e' }), true);
  assert.deepEqual(fake.events.map(([operation]) => operation), ['binary-get', 'binary-set']);

  // Known-cached hashes answer from memory; unknown ones cost one EXISTS.
  fake.events.length = 0;
  assert.equal(await isAnalysisCached(hash), true);
  assert.equal(await isAnalysisCached('5555666677778888'), false);
  assert.deepEqual(fake.events, [['exists', 'analysis:5555666677778888']]);
});

test('quota errors trip the breaker, reads fail open, and a re-probe turns the cache back on', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = createFakeClients();
  let quotaExceeded = true;
  const flakyAnalysis = {
    ...fake.analysisClient,
    async get(key) {
      if (quotaExceeded) throw new Error('ERR max requests limit exceeded. Limit: 500000, Usage: 500000');
      return fake.analysisClient.get(key);
    }
  };
  const flakyRedis = {
    ...fake.redisClient,
    async ping() {
      if (quotaExceeded) throw new Error('ERR max requests limit exceeded. Limit: 500000, Usage: 500000');
      return 'PONG';
    }
  };
  initCache({ redisClient: flakyRedis, analysisClient: flakyAnalysis });

  assert.equal(await getCachedAnalysis('9999aaaabbbbcccc'), null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(isCacheEnabled(), false);
  assert.match(getRedisDisabledReason(), /max requests limit exceeded/);

  // Still over quota at the first re-probe (6h for quota errors): stays off.
  t.mock.timers.tick(6 * 60 * 60 * 1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(isCacheEnabled(), false);

  quotaExceeded = false;
  t.mock.timers.tick(6 * 60 * 60 * 1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(isCacheEnabled(), true);
  assert.equal(getRedisDisabledReason(), null);
});

test('a missing dictionary never blocks startup; writes fall back to plain JSON', async () => {
  const fake = createFakeClients();
  initCache({ redisClient: fake.redisClient, analysisClient: fake.analysisClient });
  assert.equal(await initCacheCompression({ dictionaryPath: '/nonexistent/dictionary', writesEnabled: true }), false);
  assert.equal(getCacheCompressionStatus().writesEnabled, false);

  const hash = 'abcdabcdabcdabcd';
  assert.equal(await setCachedAnalysis(hash, { windbgOutput: 'x'.repeat(10_000) }), true);
  assert.equal(isZstdEnvelope(fake.values.get(`analysis:${hash}`)), false);
  assert.equal((await getCachedAnalysis(hash)).windbgOutput.length, 10_000);
});

test('corrupt dictionary registry entry is repaired instead of crash-looping boot', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bsod-cache-registry-'));
  const dictionaryPath = join(directory, 'cache.zdict');
  await writeFile(dictionaryPath, trainedDictionaryFixture(), { mode: 0o600 });
  t.after(() => rm(directory, { recursive: true, force: true }));

  const fake = createFakeClients();
  initCache({ redisClient: fake.redisClient, analysisClient: fake.analysisClient });
  assert.equal(
    await initCacheCompression({ dictionaryPath, writesEnabled: true, flushProbeMs: 0, refreshIntervalMs: 0 }),
    true,
  );

  const registryKey = [...fake.values.keys()].find(key => key.startsWith('cachemeta:zstd:dictionary:'));
  assert.ok(registryKey);

  // A foreign/partial value wins the registry slot (e.g. a botched manual
  // write). The next publish must repair it instead of throwing.
  fake.values.set(registryKey, Buffer.from('not-a-dictionary'));

  const hash = 'aaaaaaaaaaaaaaaa';
  const windbgOutput = 'BUGCHECK_CODE: 133\nMODULE_NAME: driver\n'.repeat(2_000);
  assert.equal(await setCachedAnalysis(hash, { windbgOutput }), true);
  assert.equal(fake.values.get(registryKey).length, 32 * 1024);
  assert.equal((await getCachedAnalysis(hash)).windbgOutput.length, windbgOutput.length);
});
