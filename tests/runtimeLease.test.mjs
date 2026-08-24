import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getRuntimeValueStrict,
  initCache,
  releaseRuntimeLease,
  renewRuntimeLease,
  setRuntimeValue,
  transitionRuntimeJobWithLease,
  tryAcquireRuntimeLease
} from '../services/cache.js';

function createFakeRedis() {
  const values = new Map();
  const ttls = new Map();
  let clockSeconds = 0;
  const expireIfNeeded = key => {
    const expiresAt = ttls.get(key);
    if (expiresAt !== undefined && expiresAt <= clockSeconds) {
      values.delete(key);
      ttls.delete(key);
    }
  };
  return {
    values,
    advance(seconds) {
      clockSeconds += seconds;
      for (const key of values.keys()) expireIfNeeded(key);
    },
    async get(key) {
      expireIfNeeded(key);
      return values.get(key) ?? null;
    },
    async set(key, value, options = {}) {
      expireIfNeeded(key);
      if (options.nx && values.has(key)) return null;
      values.set(key, value);
      if (options.ex) ttls.set(key, clockSeconds + Number(options.ex));
      return 'OK';
    },
    async eval(script, keys, args) {
      for (const key of keys) expireIfNeeded(key);
      const leaseValue = values.get(keys[0]);
      if (leaseValue !== args[0]) return 0;

      if (script.includes("redis.call('DEL'")) {
        values.delete(keys[0]);
        ttls.delete(keys[0]);
        return 1;
      }
      if (script.includes("redis.call('EXPIRE'")) {
        ttls.set(keys[0], clockSeconds + Number(args[1]));
        return 1;
      }
      if (script.includes('cjson.decode')) {
        const currentText = values.get(keys[1]);
        if (!currentText) return 0;
        const current = JSON.parse(currentText);
        if ((Number(current.version) || 0) !== Number(args[1])) return 0;
        if (current.status === 'completed' || current.status === 'failed') return 0;
        values.set(keys[1], args[2]);
        ttls.set(keys[1], clockSeconds + Number(args[3]));
        return 1;
      }
      throw new Error('Unexpected Lua script');
    }
  };
}

test('runtime leases are token-safe and job checkpoints reject stale owners', async () => {
  const redisClient = createFakeRedis();
  initCache({ redisClient, analysisClient: {} });

  const uid = 'API-1800000000000-abcdef123456';
  const jobKey = `job:${uid}`;
  const leaseKey = `job-lease:${uid}`;
  await setRuntimeValue(jobKey, {
    schemaVersion: 2,
    version: 1,
    status: 'processing',
    phase: 'polling'
  }, 3600);

  assert.equal(await tryAcquireRuntimeLease(leaseKey, 'owner-a', 60), true);
  assert.equal(await tryAcquireRuntimeLease(leaseKey, 'owner-b', 60), false);
  assert.equal(await renewRuntimeLease(leaseKey, 'owner-b', 60), false);
  assert.equal(await renewRuntimeLease(leaseKey, 'owner-a', 60), true);

  assert.equal(await transitionRuntimeJobWithLease(jobKey, leaseKey, 'owner-a', 0, {
    schemaVersion: 2,
    version: 2,
    status: 'processing',
    phase: 'downloading'
  }, 3600), false);
  assert.equal(await transitionRuntimeJobWithLease(jobKey, leaseKey, 'owner-a', 1, {
    schemaVersion: 2,
    version: 2,
    status: 'processing',
    phase: 'downloading'
  }, 3600), true);
  assert.equal((await getRuntimeValueStrict(jobKey)).phase, 'downloading');

  assert.equal(await releaseRuntimeLease(leaseKey, 'owner-b'), false);
  assert.equal(await releaseRuntimeLease(leaseKey, 'owner-a'), true);
  assert.equal(await tryAcquireRuntimeLease(leaseKey, 'owner-b', 60), true);
  assert.equal(await transitionRuntimeJobWithLease(jobKey, leaseKey, 'owner-a', 2, {
    schemaVersion: 2,
    version: 3,
    status: 'completed',
    phase: 'completed'
  }, 3600), false);
  assert.equal((await getRuntimeValueStrict(jobKey)).status, 'processing');
  assert.equal(await transitionRuntimeJobWithLease(jobKey, leaseKey, 'owner-b', 2, {
    schemaVersion: 2,
    version: 3,
    status: 'completed',
    phase: 'completed'
  }, 3600), true);
  assert.equal(await transitionRuntimeJobWithLease(jobKey, leaseKey, 'owner-b', 3, {
    schemaVersion: 2,
    version: 4,
    status: 'processing',
    phase: 'polling'
  }, 3600), false);
});

test('an expired owner cannot checkpoint or release after lease takeover', async () => {
  const redisClient = createFakeRedis();
  initCache({ redisClient, analysisClient: {} });

  const uid = 'API-1800000000000-fedcba654321';
  const jobKey = `job:${uid}`;
  const leaseKey = `job-lease:${uid}`;
  await setRuntimeValue(jobKey, {
    schemaVersion: 2,
    version: 1,
    status: 'processing',
    phase: 'reporting'
  }, 3600);

  assert.equal(await tryAcquireRuntimeLease(leaseKey, 'expired-owner', 60), true);
  redisClient.advance(61);
  assert.equal(await tryAcquireRuntimeLease(leaseKey, 'replacement-owner', 60), true);
  assert.equal(await transitionRuntimeJobWithLease(jobKey, leaseKey, 'expired-owner', 1, {
    schemaVersion: 2,
    version: 2,
    status: 'completed',
    phase: 'completed'
  }, 3600), false);
  assert.equal(await releaseRuntimeLease(leaseKey, 'expired-owner'), false);
  assert.equal(await transitionRuntimeJobWithLease(jobKey, leaseKey, 'replacement-owner', 1, {
    schemaVersion: 2,
    version: 2,
    status: 'completed',
    phase: 'completed'
  }, 3600), true);
  assert.equal((await getRuntimeValueStrict(jobKey)).status, 'completed');
});
