import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getCachedAnalysisStrict,
  getRuntimeValueStrict,
  initCache
} from '../services/cache.js';

function runtimeClient(getImpl = async () => null) {
  return {
    get: getImpl,
    async set() { return 'OK'; },
    async eval() { return 0; }
  };
}

test('strict runtime reads distinguish a genuine miss from a transport outage', async () => {
  initCache({
    redisClient: runtimeClient(),
    analysisClient: { async get() { return null; } }
  });
  assert.equal(await getRuntimeValueStrict('job:missing'), null);

  initCache({
    redisClient: runtimeClient(async () => { throw new Error('Redis transport unavailable'); }),
    analysisClient: { async get() { return null; } }
  });
  await assert.rejects(
    getRuntimeValueStrict('job:accepted'),
    /Redis transport unavailable/
  );
});

test('strict analysis reads delete corrupt values and return a genuine miss', async () => {
  const values = new Map([
    ['analysis:0123456789abcdef', Buffer.from('{not-json', 'utf8')]
  ]);
  const deleted = [];
  const analysisClient = {
    async get(key) { return values.get(key) || null; },
    async del(key) {
      deleted.push(key);
      values.delete(key);
      return true;
    }
  };
  initCache({ redisClient: runtimeClient(), analysisClient });

  assert.equal(await getCachedAnalysisStrict('0123456789abcdef'), null);
  assert.deepEqual(deleted, ['analysis:0123456789abcdef']);
  assert.equal(values.size, 0);
});

test('strict analysis reads propagate transport errors without deleting data', async () => {
  let deleteCalled = false;
  const analysisClient = {
    async get() { throw new Error('Analysis cache transport unavailable'); },
    async del() {
      deleteCalled = true;
      return true;
    }
  };
  initCache({ redisClient: runtimeClient(), analysisClient });

  await assert.rejects(
    getCachedAnalysisStrict('0123456789abcdef'),
    /Analysis cache transport unavailable/
  );
  assert.equal(deleteCalled, false);
});

test('strict analysis reads preserve zstd values when this revision has no decoder', async () => {
  let deleteCalled = false;
  const encoded = Buffer.concat([
    Buffer.from('BSODZSTD', 'ascii'),
    Buffer.from([1]),
    Buffer.alloc(32),
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  ]);
  const analysisClient = {
    async get() { return encoded; },
    async del() {
      deleteCalled = true;
      return true;
    }
  };
  initCache({ redisClient: runtimeClient(), analysisClient });

  await assert.rejects(
    getCachedAnalysisStrict('0123456789abcdef'),
    error => error?.code === 'ANALYSIS_CACHE_DECODER_UNAVAILABLE'
  );
  assert.equal(deleteCalled, false);
});
