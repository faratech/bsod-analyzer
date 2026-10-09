import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

import {
  QUOTA_ADJUST_SCRIPT,
  QUOTA_REFUND_SCRIPT,
  QUOTA_RESERVE_SCRIPT,
  RATE_LIMIT_SCRIPT,
  createQuotaLedger,
  createSharedCounterStore,
  createSharedCounterStoreFromEnv
} from '../server/sharedCounters.js';
import { createMemoryRateLimitStore } from '../server/rateLimit.js';
import { createSessionQuotaStore } from '../server/quotaStore.js';

// In-memory stand-in for the dedicated Upstash database: implements exactly the
// four scripts server/sharedCounters.js sends, against a controllable clock.
function createFakeUpstash(clock) {
  const values = new Map(); // key -> { n, expiresAt }
  const calls = [];
  const live = key => {
    const entry = values.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= clock.now) {
      values.delete(key);
      return undefined;
    }
    return entry;
  };
  const get = key => live(key)?.n ?? 0;
  const ttlMs = key => {
    const entry = live(key);
    if (!entry) return -2;
    return entry.expiresAt === null ? -1 : entry.expiresAt - clock.now;
  };
  const ttlSeconds = key => {
    const ms = ttlMs(key);
    return ms < 0 ? ms : Math.ceil(ms / 1000);
  };
  const incrby = (key, delta) => {
    const entry = live(key);
    if (entry) entry.n += delta;
    else values.set(key, { n: delta, expiresAt: null });
    return get(key);
  };
  const expireMs = (key, ms) => {
    const entry = live(key);
    if (entry) entry.expiresAt = clock.now + ms;
  };

  return {
    values,
    calls,
    async eval(script, keys, args) {
      calls.push(keys);
      const a = args.map(Number);
      switch (script) {
        case QUOTA_RESERVE_SCRIPT: {
          const [req, tok] = keys;
          if (get(req) + a[0] > a[2]) return [0, 1, get(req), get(tok), ttlSeconds(req)];
          if (get(tok) + a[1] > a[3]) return [0, 2, get(req), get(tok), ttlSeconds(tok)];
          incrby(req, a[0]);
          incrby(tok, a[1]);
          for (const key of [req, tok]) if (ttlSeconds(key) < 1) expireMs(key, a[4] * 1000);
          return [1, 0, get(req), get(tok), ttlSeconds(req)];
        }
        case QUOTA_ADJUST_SCRIPT: {
          keys.forEach((key, i) => {
            if (a[i] !== 0 && live(key)) incrby(key, Math.max(-get(key), a[i]));
          });
          return 1;
        }
        case QUOTA_REFUND_SCRIPT: {
          const [req, tok, ref] = keys;
          const refunded = get(ref);
          if (refunded >= a[2]) return [0, refunded];
          incrby(ref, 1);
          if (get(req) > 0) incrby(req, -Math.min(get(req), a[0]));
          if (get(tok) > 0) incrby(tok, -Math.min(get(tok), a[1]));
          for (const key of keys) if (ttlSeconds(key) < 1) expireMs(key, a[3] * 1000);
          return [1, refunded + 1];
        }
        case RATE_LIMIT_SCRIPT: {
          const [key] = keys;
          const hits = incrby(key, 1);
          if (hits === 1 || ttlMs(key) < 0) expireMs(key, a[0]);
          return [hits, ttlMs(key)];
        }
        default:
          throw new Error('unexpected script');
      }
    }
  };
}

const QUOTA = { requestCost: 1, tokenCost: 10, windowSeconds: 3600 };
const scope = (key, requestLimit = 3, tokenLimit = 1000) => ({ key, requestLimit, tokenLimit });

function instancePair({ shared = true } = {}) {
  const clock = { now: 1_000_000 };
  const client = createFakeUpstash(clock);
  const make = () => {
    const store = createSharedCounterStore({ client: shared ? client : null, now: () => clock.now });
    return { store, ledger: createQuotaLedger({ shared: store, local: createSessionQuotaStore() }) };
  };
  return { clock, client, a: make(), b: make() };
}

test('per-instance quotas multiply across instances; the shared store holds one budget', async () => {
  const local = instancePair({ shared: false });
  let admitted = 0;
  for (let i = 0; i < 6; i += 1) {
    const { ledger } = i % 2 ? local.b : local.a;
    if ((await ledger.reserve([scope('session-1')], QUOTA)).allowed) admitted += 1;
  }
  assert.equal(admitted, 6, 'two instances without a shared store admit twice the limit (issue #134)');

  const shared = instancePair();
  admitted = 0;
  for (let i = 0; i < 6; i += 1) {
    const { ledger } = i % 2 ? shared.b : shared.a;
    const result = await ledger.reserve([scope('session-1')], QUOTA);
    if (result.allowed) {
      admitted += 1;
      assert.equal(result.shared, true);
    } else {
      assert.equal(result.reason, 'requests');
      assert.equal(result.requests, 3);
    }
  }
  assert.equal(admitted, 3, 'the shared store admits the configured limit across instances');
});

test('the shared quota window expires and reopens', async () => {
  const { clock, a } = instancePair();
  for (let i = 0; i < 3; i += 1) assert.equal((await a.ledger.reserve([scope('s')], QUOTA)).allowed, true);
  assert.equal((await a.ledger.reserve([scope('s')], QUOTA)).allowed, false);
  clock.now += 3600 * 1000 + 1;
  assert.equal((await a.ledger.reserve([scope('s')], QUOTA)).allowed, true);
});

test('shared rate-limit stores count hits from every instance', async () => {
  const { a, b } = instancePair();
  const limiterA = a.store.rateLimitStore('gemini', 60_000);
  const limiterB = b.store.rateLimitStore('gemini', 60_000);
  const hits = [];
  for (let i = 0; i < 4; i += 1) hits.push((await (i % 2 ? limiterB : limiterA).increment('203.0.113.7')).totalHits);
  assert.deepEqual(hits, [1, 2, 3, 4]);

  // Distinct limiter names never share a counter.
  assert.equal((await a.store.rateLimitStore('archive', 60_000).increment('203.0.113.7')).totalHits, 1);

  const localA = createMemoryRateLimitStore(60_000);
  const localB = createMemoryRateLimitStore(60_000);
  assert.equal((await localA.increment('ip')).totalHits, 1);
  assert.equal((await localB.increment('ip')).totalHits, 1, 'per-instance stores count separately');
});

test('counter keys are hashed, never the raw IP, session id or API key', async () => {
  const { client, a } = instancePair();
  await a.ledger.reserve([scope('ip:203.0.113.7')], QUOTA);
  await a.store.rateLimitStore('windbg-upload', 60_000).increment('sess:abcdef0123456789');
  const keys = [...client.values.keys()].join(' ');
  assert.doesNotMatch(keys, /203\.0\.113\.7|abcdef0123456789/);
  assert.match(keys, /^rt:/);
});

test('a failing store falls back to per-instance counters and cools down', async () => {
  const clock = { now: 0 };
  const errors = [];
  let evals = 0;
  const store = createSharedCounterStore({
    client: { async eval() { evals += 1; throw new Error('ERR max requests limit exceeded'); } },
    now: () => clock.now,
    cooldownMs: 30_000,
    onError: error => errors.push(error.message)
  });
  const ledger = createQuotaLedger({ shared: store, local: createSessionQuotaStore() });

  const first = await ledger.reserve([scope('s', 1)], QUOTA);
  assert.equal(first.allowed, true, 'an outage must not fail the request (2026-09)');
  assert.equal(first.shared, false);
  assert.equal((await ledger.reserve([scope('s', 1)], QUOTA)).allowed, false, 'the local fallback still enforces the limit');
  assert.equal(evals, 1, 'the store is skipped while cooling down');
  assert.equal(errors.length, 1);

  const limiter = store.rateLimitStore('gemini', 60_000);
  assert.equal((await limiter.increment('ip')).totalHits, 1);
  assert.equal(evals, 1);

  clock.now += 30_001;
  await limiter.increment('ip');
  assert.equal(evals, 2, 'the store is retried after the cool-down');
});

test('a stalled store call times out into the local fallback', async () => {
  const errors = [];
  const store = createSharedCounterStore({
    client: { eval: () => new Promise(() => {}) },
    timeoutMs: 20,
    onError: error => errors.push(error.message)
  });
  const started = Date.now();
  const result = await store.rateLimitStore('archive', 60_000).increment('ip');
  assert.equal(result.totalHits, 1);
  assert.ok(Date.now() - started < 1000);
  assert.match(errors[0], /exceeded 20ms/);
});

test('a scope that rejects releases the scopes already reserved', async () => {
  for (const shared of [true, false]) {
    const { a } = instancePair({ shared });
    // The session already used its allowance from another address.
    assert.equal((await a.ledger.reserve([scope('ip:a', 1), scope('sess:s', 1)], QUOTA)).allowed, true);

    const rejected = await a.ledger.reserve([scope('ip:b', 1), scope('sess:s', 1)], QUOTA);
    assert.equal(rejected.allowed, false);
    assert.equal(rejected.key, 'sess:s', 'one session presented from a new IP gets no new allowance (issue #135)');

    // The ip:b reservation was rolled back, so that address still has room.
    assert.equal((await a.ledger.reserve([scope('ip:b', 1)], QUOTA)).allowed, true, `shared=${shared}`);
  }
});

test('commit and refund settle on the backend that admitted each scope', async () => {
  const { client, a, b } = instancePair();
  const reservation = await a.ledger.reserve([scope('s', 5, 1000)], { ...QUOTA, tokenCost: 100 });
  assert.equal(reservation.allowed, true);

  // Settlement on another instance reaches the same shared counters.
  await b.ledger.commit(reservation, { tokenDelta: 50 });
  let next = await b.ledger.reserve([scope('s', 5, 1000)], { ...QUOTA, tokenCost: 0 });
  assert.equal(next.tokens, 150);

  const refundArgs = { requestCost: 1, tokenCost: 100, refundCap: 1, windowSeconds: 3600 };
  assert.equal((await b.ledger.refund(reservation, refundArgs)).refunded, true);
  assert.equal((await a.ledger.refund(reservation, refundArgs)).refunded, false, 'the refund cap is shared too');
  next = await a.ledger.reserve([scope('s', 5, 1000)], { ...QUOTA, tokenCost: 0 });
  assert.equal(next.requests, 2);
  assert.equal(next.tokens, 50);

  // A reservation admitted locally (store down at the time) settles locally.
  const local = createSessionQuotaStore();
  const down = createSharedCounterStore({ client: null });
  const ledger = createQuotaLedger({ shared: down, local });
  const localReservation = await ledger.reserve([scope('s', 5, 1000)], { ...QUOTA, tokenCost: 100 });
  const before = client.calls.length;
  await createQuotaLedger({ shared: a.store, local }).commit(localReservation, { tokenDelta: 25 });
  assert.equal(client.calls.length, before, 'a locally admitted scope never touches the shared store');
  assert.equal(local.reserve('s', { requestLimit: 5, tokenLimit: 1000, tokenCost: 0, windowSeconds: 3600 }).tokens, 125);
});

test('the store is configured only by the dedicated quota variables', () => {
  assert.equal(createSharedCounterStoreFromEnv({}).configured, false);
  assert.equal(createSharedCounterStoreFromEnv({
    UPSTASH_REDIS_REST_URL: 'https://cache.example.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'cache-token'
  }).configured, false, 'the analysis-cache database is not reused for quotas');
  assert.equal(createSharedCounterStoreFromEnv({
    QUOTA_REDIS_REST_URL: 'https://quota.example.upstash.io',
    QUOTA_REDIS_REST_TOKEN: 'quota-token'
  }).configured, true);
});

// server.js has no unit tests; pin its wiring the way tests/aiHandlerScope.test.mjs does.
const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));
const serverAst = acorn.parse(readFileSync(SERVER, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });

function topLevelInit(name) {
  for (const statement of serverAst.body) {
    if (statement.type !== 'VariableDeclaration') continue;
    const declarator = statement.declarations.find(node => node.id.name === name);
    if (declarator) return declarator.init;
  }
  return null;
}

function routeMiddleware(method, path) {
  for (const statement of serverAst.body) {
    const call = statement.expression;
    if (call?.type !== 'CallExpression' || call.callee.property?.name !== method) continue;
    if (call.arguments[0]?.value !== path) continue;
    return call.arguments.slice(1, -1).map(arg => arg.type === 'Identifier' ? arg.name : arg.callee?.name || arg.callee?.property?.name);
  }
  return null;
}

test('server.js counts the cost-bearing limiters in the shared store', () => {
  for (const name of ['geminiLimiter', 'windbgUploadLimiter', 'archiveLimiter', 'externalAnalyzeSubmitLimiter',
    'windbgUploadSessionLimiter', 'archiveSessionLimiter']) {
    assert.equal(topLevelInit(name)?.callee?.name, 'sharedLimiter', `${name} must use the shared store`);
  }
});

test('server.js sizes provider budgets for every instance that can run', () => {
  const shards = topLevelInit('PROVIDER_QUOTA_SHARDS');
  assert.equal(shards?.arguments?.[1]?.name, 'MAX_INSTANCES');
  assert.equal(topLevelInit('MAX_INSTANCES')?.arguments?.[1]?.value, 10);
});

test('shared limiters run only after authentication, with session-scoped twins for uploads', () => {
  const routes = [
    ['/api/gemini/generateContent', 'requireSession', ['geminiLimiter']],
    ['/api/windbg/upload', 'requireSession', ['windbgUploadLimiter', 'windbgUploadSessionLimiter']],
    ['/api/extract-archive', 'requireSession', ['archiveLimiter', 'archiveSessionLimiter']],
    ['/api/analyze', 'requireApiKey', ['externalAnalyzeSubmitLimiter']]
  ];
  for (const [path, auth, limiters] of routes) {
    const chain = routeMiddleware('post', path);
    assert.ok(chain, `${path} must be registered`);
    const authAt = chain.indexOf(auth);
    assert.ok(authAt >= 0, `${path} must run ${auth}`);
    for (const limiter of limiters) {
      const at = chain.indexOf(limiter);
      assert.ok(at > authAt, `${path} must run ${limiter} after ${auth} (issues #134/#135)`);
    }
  }
});
