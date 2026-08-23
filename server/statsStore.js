// Upstash-backed aggregation store for crash statistics. All state lives in
// Redis (Cloud Run instances are ephemeral/multi-instance); writes are
// fire-and-forget best-effort and never throw into the request path, mirroring
// persistCrashSignal() posture in server.js.
// Key schema lives on the `stats:*` namespace (long-lived aggregates, unlike
// session-scoped `runtime:*` keys) — see plan doc / CLAUDE.md notes.
import {
  buildSnapshot as shapeSnapshot,
  normalizeDumpType,
  utcDay,
  utcHourBucket
} from './stats.js';

const SEEN_TTL_SECONDS = 48 * 60 * 60;      // idempotency window (>2 days covers UTC-day rollover)
const HOURLY_TTL_SECONDS = 26 * 60 * 60;    // last-hour gauge outlives its hour
const ZSET_MAX_MEMBERS = 500;               // cardinality cap for buckets/modules
const DAILY_KEEP_MARGIN = 6;                // keep a few days beyond the window

export const DEFAULT_SNAPSHOT_TTL_SECONDS = 60;
export const DEFAULT_DAILY_WINDOW_DAYS = 90;

export function createStatsStore({
  redis,
  getClient,
  isEnabled = () => true,
  now = () => Date.now(),
  snapshotTtlSeconds = DEFAULT_SNAPSHOT_TTL_SECONDS,
  dailyWindowDays = DEFAULT_DAILY_WINDOW_DAYS
} = {}) {
  // Redis clients initialize asynchronously (initCache during startServer), so
  // prefer a lazy getClient() accessor over a captured-at-import instance.
  function db() {
    return getClient ? getClient() : redis;
  }
  const active = () => Boolean(db()) && isEnabled();

  function key(suffix) {
    return `stats:${suffix}`;
  }

  // Records one completed crash analysis. Returns true when counters moved.
  // Dedupe: one event per (fileHash, UTC day); hashless records count
  // unconditionally (defensive — callers should always have a hash).
  async function recordAnalysis(facts) {
    if (!active() || !facts || facts.source !== 'windbg' && facts.source !== 'ai-fallback') {
      return false;
    }
    const redis = db();
    try {
      const ts = now();
      const day = utcDay(ts);

      if (facts.fileHash) {
        const seenKey = key(`seen:${day}:${facts.fileHash}`);
        const created = await redis.set(seenKey, '1', { nx: true, ex: SEEN_TTL_SECONDS });
        if (!created || created === 'null') {
          return false; // already counted for this file today
        }
      }

      const dumpType = normalizeDumpType(facts.dumpType) || 'unknown';
      const pipe = redis.pipeline();
      // Tracking-start marker: first counted event wins (SETNX), so the
      // public page can say "since <date>"; resets only if the data does.
      pipe.set(key('start'), new Date(ts).toISOString(), { nx: true });
      pipe.hincrby(key('at:total'), 'analyses', 1);
      pipe.hincrby(key('at:source'), facts.source, 1);
      pipe.hincrby(key('at:dtype'), dumpType, 1);
      if (facts.osVersion) pipe.hincrby(key('at:os'), facts.osVersion, 1);
      if (facts.stopCode) {
        pipe.hincrby(key('at:code'), facts.stopCode, 1);
        if (facts.stopCodeLabel) {
          pipe.hset(key('at:codelabel'), facts.stopCode, String(facts.stopCodeLabel).slice(0, 64));
        }
      }
      if (facts.failureBucket) {
        pipe.zincrby(key('z:bucket'), 1, facts.failureBucket);
        pipe.zremrangebyrank(key('z:bucket'), 0, -(ZSET_MAX_MEMBERS + 1));
      }
      if (facts.module) {
        pipe.zincrby(key('z:module'), 1, facts.module);
        pipe.zremrangebyrank(key('z:module'), 0, -(ZSET_MAX_MEMBERS + 1));
      }
      pipe.zincrby(key('z:daily'), 1, day);
      pipe.zremrangebyrank(key('z:daily'), 0, -(dailyWindowDays + DAILY_KEEP_MARGIN + 1));
      const hourKey = key(`h:${utcHourBucket(ts)}`);
      pipe.incrby(hourKey, 1);
      pipe.ttl(hourKey);

      const results = await pipe.exec();
      if (results.some(r => resultValue(r) instanceof Error || r?.error)) {
        throw new Error('pipeline reported command errors');
      }
      const ttl = Number(resultValue(results[results.length - 1]));
      if (!Number.isFinite(ttl) || ttl < 0) {
        // EXPIRE-on-first semantics (cf. incrementRuntimeCounter): a fresh
        // hour bucket has no TTL yet.
        await redis.expire(hourKey, HOURLY_TTL_SECONDS);
      }
      return true;
    } catch (error) {
      console.error('[Stats] record failed:', error?.message || error);
      return false;
    }
  }

  // Returns the cached public snapshot or null; never rebuilds here so the
  // public route stays one round-trip under load.
  async function getSnapshot() {
    if (!active()) return null;
    const redis = db();
    try {
      const raw = await redis.get(key('snapshot'));
      if (!raw) return null;
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
      console.error('[Stats] snapshot read failed:', error?.message || error);
      return null;
    }
  }

  // Reads every aggregate family and rewrites the cached snapshot.
  async function buildSnapshot() {
    if (!active()) return null;
    const redis = db();
    try {
      const [total, sources, dumpTypes, osVersions, stopCodes, stopCodeLabels,
        buckets, modules, daily, lastHourCount, trackingStart] = await Promise.all([
        redis.hgetall(key('at:total')),
        redis.hgetall(key('at:source')),
        redis.hgetall(key('at:dtype')),
        redis.hgetall(key('at:os')),
        redis.hgetall(key('at:code')),
        redis.hgetall(key('at:codelabel')),
        redis.zrange(key('z:bucket'), 0, -1, { rev: true, withScores: true }),
        redis.zrange(key('z:module'), 0, -1, { rev: true, withScores: true }),
        redis.zrange(key('z:daily'), 0, -1, { withScores: true }),
        redis.get(key(`h:${utcHourBucket(now())}`)),
        redis.get(key('start'))
      ]);

      const snapshot = shapeSnapshot({
        total: resultValue(total)?.analyses,
        sources,
        dumpTypes,
        osVersions,
        stopCodes,
        stopCodeLabels,
        buckets: toPairs(buckets),
        modules: toPairs(modules),
        daily: toPairs(daily),
        lastHour: Number(resultValue(lastHourCount)) || 0,
        trackingSince: resultValue(trackingStart) || null
      }, { now: now(), windowDays: dailyWindowDays });

      await redis.set(key('snapshot'), JSON.stringify(snapshot), { ex: snapshotTtlSeconds });
      return snapshot;
    } catch (error) {
      console.error('[Stats] snapshot build failed:', error?.message || error);
      return null;
    }
  }

  // Upload→download hand-off so the download hook knows the dump type
  // (the buffer only exists at upload time). TTL matches the seen window.
  async function setDumpTypeHint(fileHash, dumpType) {
    if (!active() || !fileHash) return;
    const redis = db();
    try {
      const normalized = normalizeDumpType(dumpType);
      if (!normalized) return;
      await redis.set(key(`meta:${fileHash}`), JSON.stringify({ dt: normalized }), { ex: SEEN_TTL_SECONDS });
    } catch (error) {
      console.error('[Stats] meta write failed:', error?.message || error);
    }
  }

  async function getDumpTypeHint(fileHash) {
    if (!active() || !fileHash) return undefined;
    const redis = db();
    try {
      const raw = await redis.get(key(`meta:${fileHash}`));
      if (!raw) return undefined;
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return normalizeDumpType(parsed?.dt);
    } catch (error) {
      console.error('[Stats] meta read failed:', error?.message || error);
      return undefined;
    }
  }

  return { recordAnalysis, getSnapshot, buildSnapshot, setDumpTypeHint, getDumpTypeHint };
}

// @upstash/redis pipeline results arrive as values (or [value, err] tuples on
// some versions); normalize both shapes.
function resultValue(entry) {
  if (Array.isArray(entry)) return entry[0];
  return entry;
}

// zrange replies are either flat [m1, s1, m2, s2, ...] or nested pairs
// [[m1, s1], ...] depending on client version — accept both.
function toPairs(list) {
  if (!Array.isArray(list)) return [];
  const pairs = [];
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i];
    if (Array.isArray(entry)) {
      pairs.push([String(entry[0]), Number(entry[1])]);
    } else {
      pairs.push([String(entry), Number(list[i + 1])]);
      i += 1;
    }
  }
  return pairs;
}
