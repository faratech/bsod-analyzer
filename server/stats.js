// Pure crash-statistics helpers: fact extraction/normalization and public
// snapshot shaping. No I/O and no imports from server.js so tests can exercise
// this directly (see tests/stats.test.mjs). The Upstash side lives in
// server/statsStore.js; the HTTP surface lives in server/statsRoute.js.
export const STATS_SNAPSHOT_SCHEMA = 'bsod_stats_snapshot_v1';
export const TOP_LIST_SIZE = 10;

import { extractWinDbgWindowsVersion } from '../shared/windowsVersion.js';

// ---------------------------------------------------------------------------
// Time buckets (UTC everywhere so day/hour keys are instance-independent)
// ---------------------------------------------------------------------------

export function utcDay(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10).replace(/-/g, '');
}

export function utcHourBucket(ts = Date.now()) {
  return String(Math.floor(ts / HOUR_MS));
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ---------------------------------------------------------------------------
// Normalizers — keep cardinality bounded before anything reaches Redis
// ---------------------------------------------------------------------------

// '0x7E' | '0x0000007E' | 126 | '0x1A (MEMORY_MANAGEMENT)' -> '0x7E'-style
// canonical short hex, matching normalizeBugCheckCode() in
// shared/windbgApiClient.js ('0x' + uppercase significant nibbles).
export function normalizeStopCode(value) {
  if (value === null || value === undefined) return undefined;
  let raw = String(value).trim();
  if (!raw) return undefined;
  const paren = raw.match(/^(0x[0-9a-f]+)\s*\(([^)]+)\)/i);
  let label;
  if (paren) {
    label = paren[2].trim();
    raw = paren[1];
  } else if (/^[0-9]+$/.test(raw)) {
    raw = `0x${parseInt(raw, 10).toString(16)}`;
  }
  const m = raw.match(/^0x([0-9a-f]+)$/i);
  if (!m) return undefined;
  const code = `0x${m[1].replace(/^0+(?=.)/, '').toUpperCase()}`;
  return { code, label: normalizeLabel(label) };
}

function normalizeLabel(label) {
  const text = String(label || '').trim();
  if (!text || !/^[A-Z0-9_ ]{1,64}$/i.test(text)) return undefined;
  return text.toUpperCase().slice(0, 64);
}

// '10.0.26100.1' | '10.0.26100' | banner text -> first three numeric parts.
export function normalizeOsVersion(value) {
  const m = String(value || '').match(/\b(\d{1,5}\.\d{1,5}(?:\.\d{1,5})?)\b/);
  if (!m) return undefined;
  const parts = m[1].split('.');
  return parts.length >= 3 ? m[1] : `${m[1]}.0`;
}

// FAILURE_BUCKET_ID values embed symbol offsets ('AV_nt!ExFreePool+0x12');
// strip the offset suffix so one bucket per signature, cap length.
export function normalizeFailureBucket(value) {
  let text = String(value || '').trim();
  if (!text) return undefined;
  text = text.replace(/\+0x[0-9a-f]+/gi, '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 120) return undefined;
  if (!/^[A-Za-z0-9_!.,:@#|()\[\]-]+$/.test(text)) return undefined;
  return text.slice(0, 120);
}

// Module/image names only — lowercase file-ish tokens; anything else is
// dropped rather than allowed to grow the zset unboundedly.
export function normalizeModuleKey(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return undefined;
  return /^[a-z0-9_.!+-]{1,64}$/.test(text) ? text : undefined;
}

const DUMP_TYPES = new Set(['minidump', 'kernel']);

export function normalizeDumpType(value) {
  const text = String(value || '').trim().toLowerCase();
  return DUMP_TYPES.has(text) ? text : undefined;
}

export const SOURCES = new Set(['windbg', 'ai-fallback']);

// ---------------------------------------------------------------------------
// Fact extraction — one shape in, one shape out, regardless of source path
// ---------------------------------------------------------------------------

// input: { source, fileHash, structured, analysisText, aiReport, promptText }
// - structured: windbg_crash_signal_v1 object (shared/windbgApiClient.js)
// - analysisText: raw !analyze output (OS version fallback)
// - aiReport: validated report {bugCheck, bugCheckCode, culprit, systemInfo}
// - promptText: local-path prompt text (Dump Type hint)
// Returns {fileHash?, stopCode, stopCodeLabel, failureBucket, module,
//          osVersion, dumpType} with undefined for anything unknown.
export function extractStatsFacts(input = {}) {
  const source = SOURCES.has(input.source) ? input.source : undefined;
  if (!source) return null;

  const structured = input.structured && typeof input.structured === 'object' ? input.structured : {};
  const crash = structured.crash && typeof structured.crash === 'object' ? structured.crash : {};
  const bugcheck = structured.bugcheck && typeof structured.bugcheck === 'object' ? structured.bugcheck : {};
  const report = input.aiReport && typeof input.aiReport === 'object' ? input.aiReport : {};

  let stopCode = normalizeStopCode(bugcheck.code);
  if (!stopCode) stopCode = normalizeStopCode(report.bugCheck && report.bugCheck.code);
  if (!stopCode) stopCode = normalizeStopCode(report.bugCheckCode);

  const stopCodeLabel = normalizeLabel(bugcheck.name)
    || normalizeLabel(report.bugCheck && report.bugCheck.name)
    || (stopCode && stopCode.label);

  const failureBucket = normalizeFailureBucket(
    crash.failureBucketId || (report.failureBucketId ?? undefined)
  );

  const module = normalizeModuleKey(crash.imageName)
    || normalizeModuleKey(crash.moduleName)
    || normalizeModuleKey(report.culprit)
    // Culprits are often prose; keep bare driver-ish tokens only.
    || (String(report.culprit || '').trim().match(/^([A-Za-z0-9_.!+-]{1,64})(\.sys|\.exe|\.dll)?$/i) || [])[1]?.toLowerCase();

  const osVersion = normalizeOsVersion(
    (structured.target && (structured.target.os_version || structured.target.osVersion))
    || (report.systemInfo && (report.systemInfo.windowsVersion || report.systemInfo.kernelBuild))
    || extractWinDbgWindowsVersion(input.analysisText)
  );

  const dumpType = normalizeDumpType(input.dumpType)
    || normalizeDumpType((input.promptText || '').match(/-\s*Dump Type:\s*(minidump|kernel)/i)?.[1]);

  const fileHash = typeof input.fileHash === 'string' && /^[a-f0-9]{8,64}$/i.test(input.fileHash)
    ? input.fileHash.toLowerCase()
    : undefined;

  return {
    fileHash,
    source,
    stopCode: stopCode && stopCode.code,
    stopCodeLabel,
    failureBucket,
    module,
    osVersion,
    dumpType
  };
}

// ---------------------------------------------------------------------------
// Snapshot shaping — turns raw Redis reads into the public JSON document
// ---------------------------------------------------------------------------

// raw: {
//   total, sources, dumpTypes, osVersions, stopCodes, stopCodeLabels: objects
//   buckets, modules, daily: arrays of [member, score] pairs (score numeric)
//   lastHour: number
// }
export function buildSnapshot(raw = {}, { now = Date.now(), windowDays = 90 } = {}) {
  const numMap = (obj) => {
    const out = {};
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0 && k) out[String(k).slice(0, 128)] = n;
      }
    }
    return out;
  };
  const pairList = (pairs) => (Array.isArray(pairs) ? pairs : [])
    .map(([value, score]) => [String(value ?? ''), Number(score)])
    .filter(([value, score]) => value && Number.isFinite(score) && score > 0)
    .sort((a, b) => b[1] - a[1]);

  const stopCodes = numMap(raw.stopCodes);
  const labels = raw.stopCodeLabels && typeof raw.stopCodeLabels === 'object' ? raw.stopCodeLabels : {};
  const stopEntries = Object.entries(stopCodes).sort((a, b) => b[1] - a[1]);
  const stopTotal = stopEntries.reduce((sum, [, c]) => sum + c, 0);
  const stopTopTotal = stopEntries.slice(0, TOP_LIST_SIZE).reduce((sum, [, c]) => sum + c, 0);
  const topStopCodes = {
    items: stopEntries.slice(0, TOP_LIST_SIZE).map(([code, count]) => ({
      value: code,
      label: normalizeLabel(labels[code]) || undefined,
      count
    })),
    other: Math.max(0, stopTotal - stopTopTotal),
    total: stopTotal
  };

  return {
    success: true,
    schema: STATS_SNAPSHOT_SCHEMA,
    generatedAt: new Date(now).toISOString(),
    windowDays,
    totals: { analyses: Math.max(0, Math.floor(Number(raw.total) || 0)) },
    gauges: {
      lastHour: Math.max(0, Math.floor(Number(raw.lastHour) || 0)),
      today: todayCount(raw.daily, now)
    },
    daily: dailySeries(pairList(raw.daily), now, windowDays),
    topStopCodes,
    topFailureBuckets: rankedFromPairs(pairList(raw.buckets)),
    topModules: rankedFromPairs(pairList(raw.modules)),
    osVersions: rankedCounts(numMap(raw.osVersions)),
    dumpTypes: rankedCounts(numMap(raw.dumpTypes)),
    sources: rankedCounts(numMap(raw.sources))
  };
}

// Sorts desc and keeps the top TOP_LIST_SIZE entries as [value, count] pairs.
function topEntries(entries) {
  return [...entries].sort((a, b) => b[1] - a[1]).slice(0, TOP_LIST_SIZE);
}

function rankedFromPairs(pairs) {
  const entries = topEntries(pairs.map(([value, count]) => [value, count]));
  const total = pairs.reduce((sum, [, c]) => sum + c, 0);
  const topTotal = entries.reduce((sum, [, c]) => sum + c, 0);
  return {
    items: entries.map(([value, count]) => ({ value, count })),
    other: Math.max(0, total - topTotal),
    total
  };
}

function rankedCounts(counts) {
  const entries = [...Object.entries(counts)].sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, c]) => sum + c, 0);
  const topTotal = entries.slice(0, TOP_LIST_SIZE).reduce((sum, [, c]) => sum + c, 0);
  return {
    items: entries.slice(0, TOP_LIST_SIZE).map(([value, count]) => ({ value, count })),
    other: Math.max(0, total - topTotal),
    total
  };
}

function dailySeries(dailyPairs, now, windowDays) {
  const byDay = new Map(dailyPairs.map(([day, count]) => [day, Math.floor(count)]));
  const series = [];
  for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
    const date = utcDay(new Date(now - offset * DAY_MS).getTime());
    series.push({ date, count: byDay.get(date) || 0 });
  }
  return series;
}

function todayCount(dailyPairs, now) {
  const today = utcDay(now);
  const found = (Array.isArray(dailyPairs) ? dailyPairs : [])
    .find(([day]) => String(day) === today);
  return found ? Math.max(0, Math.floor(Number(found[1]) || 0)) : 0;
}
