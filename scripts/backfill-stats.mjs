// One-shot administrative backfill for crash statistics.
//
//   node scripts/backfill-stats.mjs --source=windbg --input=/tmp/stats_backfill.jsonl
//   node scripts/backfill-stats.mjs --source=upstash
//
// Both modes DRY-RUN by default; pass --write to commit. Events are replayed
// through statsStore.recordAnalysis with their original timestamps, so all-time
// counters, daily buckets and dedupe behave exactly like live traffic. The two
// sources are time-disjoint by construction:
//   - windbg JSONL covers completed upstream jobs older than 7 days
//     (scripts/windbg-extract-jobs.py produced it on ST-WDBGAPI-01);
//   - upstash covers the analysis:* cache window (~last 7 days), which also
//     includes ai-fallback analyses that never reached the WinDBG server.
import fs from 'fs';
import {
  extractStatsFacts,
  utcDay
} from '../server/stats.js';
import {
  createStatsStore
} from '../server/statsStore.js';
import {
  getRedisCommandClient,
  getCachedAnalysis,
  initCache,
  initCacheCompression,
  isCacheEnabled
} from '../services/cache.js';

const args = process.argv.slice(2);
const opt = (name) => {
  const hit = args.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  return hit ? (hit.includes('=') ? hit.split('=').slice(1).join('=') : true) : undefined;
};

const source = opt('source');
const input = typeof opt('input') === 'string' ? opt('input') : null;
const write = Boolean(opt('write'));

function fail(message) {
  console.error(`backfill: ${message}`);
  process.exit(1);
}

if (!['windbg', 'upstash'].includes(source)) {
  fail('--source=windbg or --source=upstash required');
}
if (source === 'windbg' && !input) fail('--input=<jsonl> required for windbg source');
if (!write) console.log('(dry run — pass --write to commit)');

// Both modes write through the store, so the Redis client is always needed;
// only the upstash source additionally reads compressed values and thus
// needs the zstd dictionary loaded.
await initCache();
if (!isCacheEnabled()) fail('Upstash not configured — set UPSTASH_REDIS_REST_URL/TOKEN');
if (source === 'upstash') {
  await initCacheCompression();
}

const store = createStatsStore({
  getClient: () => getRedisCommandClient(),
  isEnabled: () => isCacheEnabled()
});

// "Windows 10 Kernel Version 26100" / bare build numbers -> dotted triple the
// shared normalizer accepts; anything coarser stays undefined.
function normalizeOs(value) {
  const text = String(value || '');
  const dotted = text.match(/\b\d{1,4}\.\d+\.\d{1,6}\b/);
  if (dotted) return dotted[0];
  const build = text.match(/\bVersion (\d{4,6})\b/i);
  return build ? `10.0.${build[1]}` : undefined;
}

const DUMP_TYPE_MAP = new Set(['kernel']);
function normalizeDtype(value) {
  if (!value) return undefined;
  return DUMP_TYPE_MAP.has(String(value).toLowerCase()) ? 'kernel' : 'minidump';
}

function summarize(events) {
  const withFacts = events.filter(e => e.facts.stopCode || e.facts.failureBucket || e.facts.module);
  const days = events.map(e => utcDay(e.ts)).sort();
  console.log(`events=${events.length} withCrashFacts=${withFacts.length} span=${days[0]}..${days.at(-1)}`);
}

async function replay(events) {
  // Oldest first so the SETNX tracking-start marker lands on the earliest.
  events.sort((a, b) => a.ts - b.ts);
  let recorded = 0;
  for (const event of events) {
    const moved = await store.recordAnalysis(event.facts, { ts: event.ts });
    if (moved) recorded += 1;
  }
  return { total: events.length, recorded, deduped: events.length - recorded };
}

function factsFromHistory({ code, name, bucket, module, os, dtype }) {
  return extractStatsFacts({
    source: 'windbg',
    structured: {
      bugcheck: { code, name },
      crash: { failureBucketId: bucket, imageName: module },
      target: { os_version: normalizeOs(os) }
    },
    dumpType: normalizeDtype(dtype)
  });
}

if (source === 'windbg') {
  const lines = fs.readFileSync(input, 'utf8').split('\n').filter(Boolean);
  const events = [];
  let unparseable = 0;
  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      unparseable += 1;
      continue;
    }
    const ts = Date.parse(row.ts || '');
    if (!Number.isFinite(ts)) {
      unparseable += 1;
      continue;
    }
    const facts = factsFromHistory(row) ?? extractStatsFacts({ source: 'windbg' });
    events.push({ ts, facts });
  }
  console.log(`windbg history: ${events.length} events (${unparseable} skipped)`);
  summarize(events);
  if (!write) {
    console.log('DRY RUN complete — nothing written.');
    process.exit(0);
  }
  const summary = await replay(events);
  console.log(`recorded=${summary.recorded} deduped=${summary.deduped}`);
} else {
  const redis = getRedisCommandClient();
  const names = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, { match: 'analysis:*', count: 500 });
    cursor = next;
    names.push(...(batch || []));
  } while (cursor !== '0');
  console.log(`analysis:* keys found: ${names.length}`);

  const events = [];
  let unreadable = 0;
  for (const key of names) {
    if (key.includes(':prompt:')) continue; // no owning file hash, no event time
    const hash = key.slice('analysis:'.length);
    const cached = await getCachedAnalysis(hash);
    if (!cached) {
      unreadable += 1;
      continue;
    }
    const ts = Number(cached.timestamp);
    const sourceName = cached.structured ? 'windbg' : 'ai-fallback';
    const facts = extractStatsFacts({
      source: sourceName,
      fileHash: hash,
      structured: cached.structured,
      aiReport: typeof cached.aiReport === 'object' ? cached.aiReport : null
    }) ?? { source: sourceName, fileHash: hash };
    events.push({ ts: Number.isFinite(ts) ? ts : Date.now(), facts });
  }
  if (unreadable) console.log(`unreadable values: ${unreadable}`);
  console.log(`upstash cache: ${events.length} events`);
  summarize(events);
  if (!write) {
    console.log('DRY RUN complete — nothing written.');
    process.exit(0);
  }
  const summary = await replay(events);
  console.log(`recorded=${summary.recorded} deduped=${summary.deduped}`);
}

// Warm the public snapshot so the page shows real numbers immediately.
const snapshot = await store.buildSnapshot();
console.log(`snapshot rebuilt: totals.analyses=${snapshot?.totals?.analyses}`);


