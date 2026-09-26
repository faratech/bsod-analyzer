// One-time export of the pre-cutover crash-statistics aggregates from Upstash
// into BigQuery. Since the cutover, /stats is computed from logged events in
// BigQuery (server/statsBigQuery.js); this carries the history recorded in
// the old Upstash `stats:*` counters forward as a single baseline row that
// server/statsStore.js folds into every snapshot.
//
//   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... \
//     node scripts/export-stats-baseline.mjs > baseline.jsonl
//   bq insert <project>:bsod_stats.baseline baseline.jsonl
//
// Prints one JSONL row {captured_at, raw}. The Upstash counters stopped
// moving at the cutover, so re-running yields the same numbers; the newest
// row wins, so nothing is double counted.
import { initCache, getRedisCommandClient, isCacheEnabled } from '../services/cache.js';

// stdout carries only the JSONL row; the cache module's logs go to stderr.
console.log = (...args) => console.error(...args);
// redis.cfg keeps the app off Upstash; this script is an explicit reader.
process.env.REDIS_ENABLED ??= 'true';
initCache();
const redis = getRedisCommandClient();
if (!isCacheEnabled() || !redis) {
  console.error('export-stats-baseline: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN');
  process.exit(1);
}

// zrange withScores replies are flat [m1, s1, ...] or nested [[m1, s1], ...].
function toPairs(list) {
  const pairs = [];
  for (let i = 0; i < (list || []).length; i += 1) {
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

const key = suffix => `stats:${suffix}`;
const [total, sources, dumpTypes, osVersions, stopCodes, stopCodeLabels, buckets, modules, daily, start] =
  await Promise.all([
    redis.hgetall(key('at:total')),
    redis.hgetall(key('at:source')),
    redis.hgetall(key('at:dtype')),
    redis.hgetall(key('at:os')),
    redis.hgetall(key('at:code')),
    redis.hgetall(key('at:codelabel')),
    redis.zrange(key('z:bucket'), 0, -1, { withScores: true }),
    redis.zrange(key('z:module'), 0, -1, { withScores: true }),
    redis.zrange(key('z:daily'), 0, -1, { withScores: true }),
    redis.get(key('start'))
  ]).catch(error => {
    console.error(`export-stats-baseline: Upstash rejected the read: ${error.message.split(', command was')[0]}`);
    console.error('If this is the plan limit, upgrade the database (or wait for the monthly reset) and re-run.');
    process.exit(1);
  });

const raw = {
  total: Number(total?.analyses) || 0,
  sources: sources || {},
  dumpTypes: dumpTypes || {},
  osVersions: osVersions || {},
  stopCodes: stopCodes || {},
  stopCodeLabels: stopCodeLabels || {},
  buckets: toPairs(buckets),
  modules: toPairs(modules),
  daily: toPairs(daily),
  trackingSince: typeof start === 'string' ? start : null
};

console.error(`export-stats-baseline: ${raw.total} analyses since ${raw.trackingSince || 'unknown'}`);
process.stdout.write(`${JSON.stringify({ captured_at: new Date().toISOString(), raw: JSON.stringify(raw) })}\n`);
