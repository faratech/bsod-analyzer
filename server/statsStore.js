// Crash-statistics store. Recording is one structured log line per completed
// analysis (see toStatsEvent) — no network call, nothing to rate-limit, and
// the Cloud Logging sink makes it durable in BigQuery. Snapshots are computed
// by the injected source (server/statsGcsSource.js: JSON that BigQuery scheduled
// queries publish to Cloud Storage) and memoized per instance;
// if a rebuild fails, the last good snapshot keeps being served.
import {
  STATS_EVENT,
  buildSnapshot as shapeSnapshot,
  mergeStatsRaw,
  toStatsEvent
} from './stats.js';

export const DEFAULT_SNAPSHOT_TTL_SECONDS = 30 * 60;
export const DEFAULT_DAILY_WINDOW_DAYS = 90;

export function createStatsStore({
  source,
  emit,
  isEnabled = () => true,
  now = () => Date.now(),
  snapshotTtlSeconds = DEFAULT_SNAPSHOT_TTL_SECONDS,
  dailyWindowDays = DEFAULT_DAILY_WINDOW_DAYS
} = {}) {
  let memo = null; // { snapshot, builtAt }
  let inFlight = null;

  // Records one completed crash analysis. Dedupe (one counted event per file
  // hash per UTC day) happens at query time, so every run is logged.
  function recordAnalysis(facts) {
    if (!isEnabled() || !facts || (facts.source !== 'windbg' && facts.source !== 'ai-fallback')) {
      return false;
    }
    try {
      emit(STATS_EVENT, toStatsEvent(facts));
      return true;
    } catch (error) {
      console.error('[Stats] record failed:', error?.message || error);
      return false;
    }
  }

  // Returns the memoized snapshot while fresh, else null.
  function getSnapshot() {
    if (!isEnabled() || !memo) return null;
    return now() - memo.builtAt < snapshotTtlSeconds * 1000 ? memo.snapshot : null;
  }

  // Rebuilds from the source (single-flight per instance). Falls back to the
  // last good snapshot on failure so the page degrades to "slightly stale".
  async function buildSnapshot() {
    if (!isEnabled() || !source) return null;
    if (!inFlight) {
      inFlight = (async () => {
        try {
          const { live, baseline, insights = null } = await source.load({ windowDays: dailyWindowDays });
          const snapshot = {
            ...shapeSnapshot(mergeStatsRaw(baseline, live), { now: now(), windowDays: dailyWindowDays }),
            insights
          };
          memo = { snapshot, builtAt: now() };
          return snapshot;
        } catch (error) {
          console.error('[Stats] snapshot build failed:', error?.message || error);
          return memo?.snapshot ?? null;
        } finally {
          inFlight = null;
        }
      })();
    }
    return inFlight;
  }

  return { recordAnalysis, getSnapshot, buildSnapshot };
}
