// Rebuilds pre-cutover crash-statistics history from the WinDBG server's own
// job database — the fallback when the old Upstash `stats:*` counters cannot
// be read (scripts/export-stats-baseline.mjs is the exact path when they can).
//
//   On ST-WDBGAPI-01:
//     python windbg-extract-jobs.py --before 2026-09-26T03:39
//   Here, with the JSONL it wrote:
//     node scripts/import-windbg-history.mjs --before=2026-09-26T03:39:00Z stats_backfill.jsonl > baseline.jsonl
//     bq insert <project>:bsod_stats.baseline baseline.jsonl
//
// --before must be the BigQuery cutover (first `stats.analysis` event), so no
// analysis is counted both here and live. Covers WinDBG analyses only: local
// AI-fallback analyses never reached the WinDBG server. Jobs carry no file
// hash, so each completed job counts once. Prints one baseline JSONL row.
import fs from 'node:fs';
import { extractStatsFacts, normalizeDumpType, utcDay } from '../server/stats.js';

const args = process.argv.slice(2);
const before = Date.parse(args.find(a => a.startsWith('--before='))?.slice('--before='.length) || '');
const input = args.find(a => !a.startsWith('--'));
if (!input || !Number.isFinite(before)) {
  console.error('usage: node scripts/import-windbg-history.mjs --before=<ISO cutover> <stats_backfill.jsonl>');
  process.exit(1);
}

// "Windows 10 Kernel Version 26100" / bare build numbers -> dotted triple the
// shared normalizer accepts; anything coarser stays undefined.
function normalizeOs(value) {
  const text = String(value || '');
  const dotted = text.match(/\b\d{1,4}\.\d+\.\d{1,6}\b/);
  if (dotted) return dotted[0];
  const build = text.match(/\bVersion (\d{4,6})\b/i);
  return build ? `10.0.${build[1]}` : undefined;
}

// The WinDBG server records 'kernel' or a minidump variant.
function normalizeDtype(value) {
  if (!value) return undefined;
  return String(value).toLowerCase() === 'kernel' ? 'kernel' : 'minidump';
}

const count = (map, key) => { if (key) map[key] = (map[key] || 0) + 1; };
const raw = {
  total: 0,
  sources: {},
  dumpTypes: {},
  osVersions: {},
  stopCodes: {},
  stopCodeLabels: {},
  buckets: {},
  modules: {},
  daily: {},
  trackingSince: null
};
let skipped = 0;
let afterCutover = 0;
let earliest = Infinity;
const labelSeenAt = {};

for (const line of fs.readFileSync(input, 'utf8').split('\n').filter(Boolean)) {
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    skipped += 1;
    continue;
  }
  const ts = Date.parse(row.ts || '');
  if (!Number.isFinite(ts)) {
    skipped += 1;
    continue;
  }
  if (ts >= before) {
    afterCutover += 1;
    continue;
  }
  const facts = extractStatsFacts({
    source: 'windbg',
    structured: {
      bugcheck: { code: row.code, name: row.name },
      crash: { failureBucketId: row.bucket, imageName: row.module },
      target: { os_version: normalizeOs(row.os) }
    },
    dumpType: normalizeDtype(row.dtype)
  });
  raw.total += 1;
  count(raw.sources, 'windbg');
  count(raw.dumpTypes, normalizeDumpType(facts.dumpType) || 'unknown');
  count(raw.osVersions, facts.osVersion);
  count(raw.stopCodes, facts.stopCode);
  if (facts.stopCode && facts.stopCodeLabel && ts >= (labelSeenAt[facts.stopCode] || 0)) {
    raw.stopCodeLabels[facts.stopCode] = facts.stopCodeLabel;
    labelSeenAt[facts.stopCode] = ts;
  }
  count(raw.buckets, facts.failureBucket);
  count(raw.modules, facts.module);
  count(raw.daily, utcDay(ts));
  earliest = Math.min(earliest, ts);
}

const baseline = {
  ...raw,
  buckets: Object.entries(raw.buckets),
  modules: Object.entries(raw.modules),
  daily: Object.entries(raw.daily),
  trackingSince: Number.isFinite(earliest) ? new Date(earliest).toISOString() : null
};
console.error(
  `import-windbg-history: ${baseline.total} analyses since ${baseline.trackingSince || 'n/a'} ` +
  `(${afterCutover} at/after the cutover skipped, ${skipped} unparseable)`
);
process.stdout.write(`${JSON.stringify({ captured_at: new Date().toISOString(), raw: JSON.stringify(baseline) })}\n`);
