// Public crash-statistics fetcher. Unlike geminiProxy.ts this endpoint is
// unauthenticated: same-origin GET, no credentials, no session retry logic.
export interface RankedCount {
  value: string;
  label?: string;
  count: number;
}

export interface RankedFamily {
  items: RankedCount[];
  other: number;
  total: number;
}

export interface KeyCount {
  k: string;
  n: number;
}

/** Daily-built aggregates over the full WinDBG corpus (bigquery/crash_insights.sql). */
export interface CorpusInsights {
  schema: string;
  totals: {
    analyses: number;
    distinct_modules: number;
    median_analysis_seconds: number | null;
    median_uptime_seconds: number | null;
    crashes_within_first_minute: number;
    ai_hardware_share: number | null;
    since: string | null;
  };
  uptime: KeyCount[];
  /** d: 0=Monday..6=Sunday, h: 0-23, both UTC. */
  utc_heatmap: { d: number; h: number; n: number }[];
  windows_releases: KeyCount[];
  product_types: KeyCount[];
  cpu_threads: (KeyCount & { o: number })[];
  gpu_stacks: KeyCount[];
  ai_driver_categories: KeyCount[];
  ai_manufacturers: KeyCount[];
  ai_hardware_split: { hardware: number; software: number };
  ai_hardware_types: KeyCount[];
  processes: KeyCount[];
  stop_code_trends: { code: string; name: string | null; weeks: { w: string; n: number }[] }[];
  weekly_totals: { w: string; n: number }[];
  code_module_matrix: { codes: string[]; modules: string[]; cells: { c: string; m: string; n: number }[] };
  dump_types: (KeyCount & { median_bytes: number | null })[];
}

export interface StatsSnapshot {
  success: boolean;
  schema: string;
  generatedAt: string;
  windowDays: number;
  totals: { analyses: number };
  gauges: { lastHour: number; today: number; runsToday: number };
  /** ISO timestamp of the first counted analysis; null until data exists. */
  trackingSince: string | null;
  daily: { date: string; count: number }[];
  topStopCodes: RankedFamily;
  topFailureBuckets: RankedFamily;
  topModules: RankedFamily;
  osVersions: RankedFamily;
  dumpTypes: RankedFamily;
  sources: RankedFamily;
  /** Corpus-wide insights; null until the first daily build is published. */
  insights?: CorpusInsights | null;
}

export class StatsUnavailableError extends Error {
  code: string;

  constructor(code: string) {
    super(`Stats unavailable (${code})`);
    this.name = 'StatsUnavailableError';
    this.code = code;
  }
}

export async function fetchStatsSnapshot(signal?: AbortSignal): Promise<StatsSnapshot> {
  const response = await fetch('/api/stats', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'omit',
    signal
  });
  if (response.status === 503) {
    let code = 'STATS_UNAVAILABLE';
    try {
      const body = await response.json();
      if (body?.code) code = String(body.code);
    } catch { /* keep default code */ }
    throw new StatsUnavailableError(code);
  }
  if (!response.ok) {
    throw new Error(`Stats request failed with status ${response.status}`);
  }
  const snapshot = (await response.json()) as StatsSnapshot;
  if (!snapshot || !Array.isArray(snapshot.daily)) {
    throw new Error('Malformed stats snapshot');
  }
  return snapshot;
}
