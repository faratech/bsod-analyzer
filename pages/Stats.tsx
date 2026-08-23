// Public crash-statistics pages:
//  - default export StatsPage      -> /stats        (prerendered, full chrome)
//  - named export StatsEmbedPage   -> /stats/embed  (chromeless iframe widget)
// Data loads client-side only with deterministic '—' placeholders so the
// prerendered markup hydrates byte-identically.
import React, { useEffect, useState } from 'react';
import SEO from '../components/SEO';
import PageLayout from '../components/PageLayout';
import { BarList, DailyVolumeChart, SplitBar, StatTile } from '../components/StatsCharts';
import {
  StatsSnapshot,
  StatsUnavailableError,
  fetchStatsSnapshot
} from '../services/statsService';

function useStatsSnapshot(refreshMs?: number) {
  const [snapshot, setSnapshot] = useState<StatsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const load = async () => {
      try {
        const next = await fetchStatsSnapshot(controller.signal);
        if (!cancelled) {
          setSnapshot(next);
          setError(null);
        }
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        setError(err instanceof StatsUnavailableError
          ? 'Statistics are temporarily unavailable.'
          : 'Failed to load statistics.');
      }
    };
    void load();
    if (refreshMs && refreshMs > 0) {
      const timer = setInterval(load, refreshMs);
      return () => {
        cancelled = true;
        controller.abort();
        clearInterval(timer);
      };
    }
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [refreshMs]);

  return { snapshot, error };
}

function formatCount(value?: number): string {
  return typeof value === 'number' ? value.toLocaleString('en-US') : '—';
}

const StatsPage: React.FC = () => {
  const { snapshot, error } = useStatsSnapshot();
  const daily = snapshot?.daily ?? [];
  return (
    <PageLayout
      title="Windows Crash Statistics"
      subtitle="Live and historical aggregates from real BSOD analyses"
      description="Top Windows stop codes, failure buckets, and faulting drivers aggregated from community BSOD dump analyses on BSOD AI Analyzer."
      keywords="bsod statistics, stop code statistics, windows crash stats, bugcheck trends"
      canonicalPath="/stats"
    >
      <SEO
        title="Windows Crash Statistics"
        description="Aggregated Windows crash statistics: most common stop codes, failure buckets, faulting modules, and daily analysis volume."
      />
      {error ? <p className="stats-error" role="alert">{error}</p> : null}
      <div className="stats-tiles">
        <StatTile label="Analyses (all time)" value={formatCount(snapshot?.totals.analyses)} />
        <StatTile label="Today (UTC)" value={formatCount(snapshot?.gauges.today)} />
        <StatTile label="Last hour" value={formatCount(snapshot?.gauges.lastHour)} />
      </div>

      <DailyVolumeChart daily={daily} />

      <div className="stats-grid">
        <SplitBar
          title="Analysis source"
          parts={[
            { label: 'WinDBG', value: snapshot?.sources.items.find(i => i.value === 'windbg')?.count ?? 0 },
            { label: 'AI fallback', value: snapshot?.sources.items.find(i => i.value === 'ai-fallback')?.count ?? 0 }
          ]}
        />
        <SplitBar
          title="Dump type"
          parts={[
            { label: 'Kernel', value: snapshot?.dumpTypes.items.find(i => i.value === 'kernel')?.count ?? 0 },
            { label: 'Minidump', value: snapshot?.dumpTypes.items.find(i => i.value === 'minidump')?.count ?? 0 }
          ]}
        />
      </div>

      <div className="stats-grid">
        <BarList title="Top stop codes" family={snapshot?.topStopCodes ?? { items: [], other: 0, total: 0 }} />
        <BarList title="Top failure buckets" family={snapshot?.topFailureBuckets ?? { items: [], other: 0, total: 0 }} />
        <BarList title="Top faulting modules" family={snapshot?.topModules ?? { items: [], other: 0, total: 0 }} max={10} />
      </div>

      <BarList title="Windows versions" family={snapshot?.osVersions ?? { items: [], other: 0, total: 0 }} />

      <details className="stats-table">
        <summary>View as table</summary>
        <table>
          <caption>Daily analysis volume (dates in UTC)</caption>
          <thead>
            <tr><th scope="col">Date (UTC)</th><th scope="col">Analyses</th></tr>
          </thead>
          <tbody>
            {[...daily].reverse().map(d => (
              <tr key={d.date}><td>{d.date}</td><td>{d.count}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
      <p className="stats-note">Counts are anonymous aggregates. Days and hours are UTC.</p>
    </PageLayout>
  );
};

const EMBED_REFRESH_MS = 5 * 60 * 1000;

const StatsEmbedPage: React.FC = () => {
  const { snapshot, error } = useStatsSnapshot(EMBED_REFRESH_MS);
  // Query params are client-only; keep first render deterministic.
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    setCompact(new URLSearchParams(window.location.search).get('compact') === '1');
  }, []);
  return (
    <main className={`stats-embed${compact ? ' is-compact' : ''}`}>
      <SEO title="Crash Statistics Widget" description="Embedded Windows crash statistics." noindex />
      {error ? <p className="stats-error" role="alert">{error}</p> : null}
      <div className="stats-tiles">
        <StatTile label="All time" value={formatCount(snapshot?.totals.analyses)} />
        <StatTile label="Today" value={formatCount(snapshot?.gauges.today)} />
        <StatTile label="Last hour" value={formatCount(snapshot?.gauges.lastHour)} />
      </div>
      <DailyVolumeChart daily={snapshot?.daily ?? []} />
      <BarList title="Top stop codes" family={snapshot?.topStopCodes ?? { items: [], other: 0, total: 0 }} max={3} />
      <p className="stats-note">
        Powered by{' '}
        <a href="https://bsod.windowsforum.com/stats" target="_blank" rel="noopener noreferrer">
          BSOD AI Analyzer
        </a>
      </p>
    </main>
  );
};

export { StatsEmbedPage };
export default StatsPage;
