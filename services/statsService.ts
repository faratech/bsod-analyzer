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

export interface StatsSnapshot {
  success: boolean;
  schema: string;
  generatedAt: string;
  windowDays: number;
  totals: { analyses: number };
  gauges: { lastHour: number; today: number };
  daily: { date: string; count: number }[];
  topStopCodes: RankedFamily;
  topFailureBuckets: RankedFamily;
  topModules: RankedFamily;
  osVersions: RankedFamily;
  dumpTypes: RankedFamily;
  sources: RankedFamily;
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
