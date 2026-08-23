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

function formatTrackingSince(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

interface InsightPayload {
  available?: boolean;
  text?: string;
  model?: string;
  generatedAt?: string;
}

function StatsInsightCard() {
  // Deterministic placeholder during prerender/hydration; hidden entirely when
  // the AI layer is unavailable so the page never shows an empty box.
  const [insight, setInsight] = useState<InsightPayload | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/stats/insight', { signal: controller.signal })
      .then(res => (res.ok ? res.json() : null))
      .then(body => {
        if (body?.available && body.text) setInsight(body);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  if (!insight) return null;
  const generated = insight.generatedAt
    ? new Date(insight.generatedAt).toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })
    : null;
  return (
    <section className="stats-insight" aria-label="AI-generated crash trend summary">
      <h3 className="chart-title">What the data says</h3>
      {insight.text?.split(/\n{2,}/).map((paragraph, i) => (
        <p key={i}>{paragraph}</p>
      ))}
      <p className="stats-insight-meta">
        AI-generated summary
        {generated ? ` · ${generated} UTC` : ''}
        {insight.model ? ` · ${insight.model}` : ''}
        {' · '}may contain mistakes — verify against the tables below
      </p>
    </section>
  );
}

const StatsPage: React.FC = () => {
  const { snapshot, error } = useStatsSnapshot();
  const daily = snapshot?.daily ?? [];
  const trackingSinceLabel = formatTrackingSince(snapshot?.trackingSince);
  // Snapshot freshness stamp, rendered in UTC.
  const lastUpdatedLabel = snapshot?.generatedAt && !Number.isNaN(Date.parse(snapshot.generatedAt))
    ? new Date(snapshot.generatedAt).toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })
    : null;
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
        <StatTile
          label="Analyses (all time)"
          value={formatCount(snapshot?.totals.analyses)}
          hint={trackingSinceLabel ? `Tracking since ${trackingSinceLabel}` : undefined}
        />
        <StatTile label="Unique dumps today" value={formatCount(snapshot?.gauges.today)} />
        <StatTile label="Analysis runs today" value={formatCount(snapshot?.gauges.runsToday)} />
        <StatTile label="Runs · last hour" value={formatCount(snapshot?.gauges.lastHour)} />
      </div>

      <DailyVolumeChart daily={daily} />

      <StatsInsightCard />

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
      <p className="stats-note">
        Counts are anonymous aggregates. Days and hours are UTC.
        {trackingSinceLabel ? ` Tracking since ${trackingSinceLabel}.` : ''}
        {lastUpdatedLabel ? ` Last updated ${lastUpdatedLabel} UTC.` : ''}
      </p>
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
        <StatTile label="Unique today" value={formatCount(snapshot?.gauges.today)} />
        <StatTile label="Runs · 1h" value={formatCount(snapshot?.gauges.lastHour)} />
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
