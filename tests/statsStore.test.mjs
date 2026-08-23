import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createStatsStore } from '../server/statsStore.js';

// Minimal in-memory Redis fake covering the ops statsStore uses. Deliberately
// independent of tests/cacheIntegration.test.mjs's createFakeClients because
// hash/zset/pipeline semantics differ.
function createFakeRedis({ failWrites = false } = {}) {
  const strings = new Map();   // key -> { value, expiresAt|null }
  const hashes = new Map();    // key -> Map(field -> string)
  const zsets = new Map();     // key -> Map(member -> number)
  let clock = 1_700_000_000_000;

  const alive = (entry) => entry && (entry.expiresAt === null || entry.expiresAt > clock);
  const key = (k) => String(k);

  function zadd(map, member, delta) {
    const next = (map.get(member) || 0) + delta;
    if (next <= 0) map.delete(member); else map.set(member, next);
  }

  const api = {
    _clock: () => clock,
    _tick(ms) { clock += ms; },
    _strings: strings,
    _hashes: hashes,
    _zsets: zsets,

    async set(k, value, opts = {}) {
      if (failWrites) throw new Error('boom');
      const existing = strings.get(key(k));
      if (opts.nx && alive(existing)) return null;
      strings.set(key(k), {
        value: String(value),
        expiresAt: opts.ex ? clock + opts.ex * 1000 : null
      });
      return 'OK';
    },
    async get(k) {
      const entry = strings.get(key(k));
      return alive(entry) ? entry.value : null;
    },
    async expire(k, seconds) {
      const entry = strings.get(key(k));
      if (!alive(entry)) return 0;
      entry.expiresAt = clock + seconds * 1000;
      return 1;
    },
    async ttl(k) {
      const entry = strings.get(key(k));
      if (!alive(entry)) return -2;
      if (entry.expiresAt === null) return -1;
      return Math.ceil((entry.expiresAt - clock) / 1000);
    },
    async incrby(k, delta) {
      const current = Number(await api.get(k)) || 0;
      await api.set(k, String(current + Number(delta)));
      return current + Number(delta);
    },
    async hincrby(k, field, delta) {
      if (!hashes.has(key(k))) hashes.set(key(k), new Map());
      const map = hashes.get(key(k));
      const next = (Number(map.get(String(field))) || 0) + Number(delta);
      map.set(String(field), String(next));
      return next;
    },
    async hgetall(k) {
      const map = hashes.get(key(k));
      if (!map) return {};
      return Object.fromEntries(map);
    },
    async hset(k, field, value) {
      if (!hashes.has(key(k))) hashes.set(key(k), new Map());
      hashes.get(key(k)).set(String(field), String(value));
      return 1;
    },
    async zincrby(k, delta, member) {
      if (!zsets.has(key(k))) zsets.set(key(k), new Map());
      zadd(zsets.get(key(k)), String(member), Number(delta));
      return zsets.get(key(k)).get(String(member));
    },
    async zremrangebyrank(k, start, stop) {
      const map = zsets.get(key(k));
      if (!map) return 0;
      const ranked = [...map.entries()].sort((a, b) => a[1] - b[1]);
      const size = ranked.length;
      const from = start < 0 ? size + start : start;
      const to = stop < 0 ? size + stop : stop;
      let removed = 0;
      for (let i = from; i <= Math.min(to, size - 1); i += 1) {
        if (map.delete(ranked[i][0])) removed += 1;
      }
      return removed;
    },
    async zrange(k, start, end, opts = {}) {
      const map = zsets.get(key(k));
      if (!map) return [];
      const ranked = [...map.entries()].sort((a, b) => a[1] - b[1]);
      if (opts.rev) ranked.reverse();
      const size = ranked.length;
      const from = start < 0 ? Math.max(0, size + start) : start;
      const to = end < 0 ? size + end : Math.min(end, size - 1);
      const slice = ranked.slice(from, to + 1);
      if (!opts.withScores) return slice.map(([m]) => m);
      return slice.flatMap(([m, s]) => [m, String(s)]);
    },
    pipeline() {
      const queue = [];
      const pipe = {
        set(k, v, opts) { queue.push(['set', k, v, opts]); return pipe; },
        hincrby(k, f, d) { queue.push(['hincrby', k, f, d]); return pipe; },
        hset(k, f, v) { queue.push(['hset', k, f, v]); return pipe; },
        zincrby(k, d, m) { queue.push(['zincrby', k, d, m]); return pipe; },
        zremrangebyrank(k, s, e) { queue.push(['zremrangebyrank', k, s, e]); return pipe; },
        incrby(k, d) { queue.push(['incrby', k, d]); return pipe; },
        ttl(k) { queue.push(['ttl', k]); return pipe; },
        async exec() {
          const results = [];
          for (const [op, ...args] of queue) {
            if (failWrites) { results.push(new Error('boom')); continue; }
            results.push(await api[op](...args));
          }
          return results;
        }
      };
      return pipe;
    }
  };
  return api;
}

const WINDGBG_FACTS = {
  fileHash: 'abcdef0123456789',
  source: 'windbg',
  stopCode: '0x1A',
  stopCodeLabel: 'MEMORY_MANAGEMENT',
  failureBucket: 'AV_nt!ExFreePool',
  module: 'nvlddmkm.sys',
  osVersion: '10.0.26100',
  dumpType: 'kernel'
};

function fixedStore(redis, { nowMs = Date.UTC(2026, 7, 23, 12), ...rest } = {}) {
  return createStatsStore({
    redis,
    now: () => nowMs,
    snapshotTtlSeconds: 60,
    dailyWindowDays: 90,
    ...rest
  });
}

const FIXED_DAY = '20260823';

test('recordAnalysis moves every counter family once', async () => {
  const redis = createFakeRedis();
  const store = fixedStore(redis);
  assert.equal(await store.recordAnalysis(WINDGBG_FACTS), true);

  assert.equal(await redis.get(`stats:seen:${FIXED_DAY}:abcdef0123456789`), '1');
  const total = await redis.hgetall('stats:at:total');
  assert.equal(total.analyses, '1');
  assert.equal((await redis.hgetall('stats:at:source')).windbg, '1');
  assert.equal((await redis.hgetall('stats:at:dtype')).kernel, '1');
  assert.equal((await redis.hgetall('stats:at:os'))['10.0.26100'], '1');
  assert.equal((await redis.hgetall('stats:at:code'))['0x1A'], '1');
  assert.equal((await redis.hgetall('stats:at:codelabel'))['0x1A'], 'MEMORY_MANAGEMENT');
  assert.deepEqual(await redis.zrange('stats:z:bucket', 0, -1, { withScores: true }), ['AV_nt!ExFreePool', '1']);
  assert.deepEqual(await redis.zrange('stats:z:module', 0, -1), ['nvlddmkm.sys']);
  assert.deepEqual(await redis.zrange('stats:z:daily', 0, -1), [FIXED_DAY]);
});

test('same fileHash on the same UTC day counts once; next day counts again', async () => {
  const redis = createFakeRedis();
  let nowMs = Date.UTC(2026, 7, 23, 12);
  const store = createStatsStore({ redis, now: () => nowMs });

  assert.equal(await store.recordAnalysis(WINDGBG_FACTS), true);
  // Second hook for the same file, hours later the same UTC day.
  nowMs += 3 * 3600 * 1000;
  assert.equal(await store.recordAnalysis({ ...WINDGBG_FACTS, source: 'ai-fallback' }), false);
  assert.equal((await redis.hgetall('stats:at:total')).analyses, '1');
  // Next UTC day: counts again.
  nowMs += 24 * 3600 * 1000;
  assert.equal(await store.recordAnalysis(WINDGBG_FACTS), true);
  assert.equal((await redis.hgetall('stats:at:total')).analyses, '2');
});

test('hashless records still count (defensive)', async () => {
  const redis = createFakeRedis();
  const store = fixedStore(redis);
  assert.equal(await store.recordAnalysis({ source: 'ai-fallback' }), true);
  assert.equal((await redis.hgetall('stats:at:total')).analyses, '1');
});

test('getSnapshot returns cached copy; buildSnapshot writes and shapes it', async () => {
  const redis = createFakeRedis();
  const store = fixedStore(redis);
  assert.equal(await store.getSnapshot(), null);

  await store.recordAnalysis(WINDGBG_FACTS);
  const snapshot = await store.buildSnapshot();
  assert.equal(snapshot.totals.analyses, 1);
  assert.equal(snapshot.trackingSince, '2026-08-23T12:00:00.000Z');
  assert.equal(snapshot.gauges.today, 1);
  assert.equal(snapshot.topStopCodes.items[0].value, '0x1A');
  assert.equal(snapshot.daily.at(-1).count, 1);

  const cached = await store.getSnapshot();
  assert.deepEqual(cached, snapshot);
  // Cached copy survives without rebuilding: bump counters, stale cache wins.
  await store.recordAnalysis({ ...WINDGBG_FACTS, fileHash: 'ffffffffffffffff' });
  assert.equal((await store.getSnapshot()).totals.analyses, 1);
});

test('hourly gauge gets EXPIRE-on-first', async () => {
  const redis = createFakeRedis();
  const store = fixedStore(redis);
  await store.recordAnalysis(WINDGBG_FACTS);
  const keys = [...redis._strings.keys()].filter(k => k.startsWith('stats:h:'));
  assert.equal(keys.length, 1);
  const ttlAfterFirst = await redis.ttl(keys[0]);
  assert.ok(ttlAfterFirst > 0 && ttlAfterFirst <= 26 * 3600, `ttl=${ttlAfterFirst}`);
});

test('disabled store is a no-op; write failures are swallowed', async () => {
  const disabled = fixedStore(createFakeRedis(), { isEnabled: () => false });
  assert.equal(await disabled.recordAnalysis(WINDGBG_FACTS), false);
  assert.equal(await disabled.getSnapshot(), null);
  assert.equal(await disabled.buildSnapshot(), null);

  const failing = fixedStore(createFakeRedis({ failWrites: true }));
  assert.equal(await failing.recordAnalysis(WINDGBG_FACTS), false); // swallowed
  assert.equal(await failing.getSnapshot(), null);
});
