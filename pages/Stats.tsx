// Public crash-statistics pages:
//  - default export StatsPage      -> /stats        (prerendered, full chrome)
//  - named export StatsEmbedPage   -> /stats/embed  (chromeless iframe widget)
// Data loads client-side only with deterministic '—' placeholders so the
// prerendered markup hydrates byte-identically.
import React, { useEffect, useState } from 'react';
import SEO from '../components/SEO';
import PageLayout from '../components/PageLayout';
import { MultiplexAd, HorizontalAd } from '../components/AdSense';
import { BarList, DailyVolumeChart, SplitBar, StatTile } from '../components/StatsCharts';
import {
  CodeModuleMatrix,
  ColumnHistogram,
  StopCodeTrends,
  WeekHourHeatmap,
  formatDuration,
  toFamily
} from '../components/CorpusInsightCharts';
import type { CorpusInsights } from '../services/statsService';
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

      {/* Horizontal ad after the charts, before the rankings */}
      <HorizontalAd
        className="ad-inline"
        style={{ margin: '2.5rem 0' }}
      />

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

      {snapshot?.insights ? <CorpusInsightsSection insights={snapshot.insights} /> : null}

      {/* Multiplex unit before the data table */}
      <MultiplexAd style={{ margin: '2.5rem 0', minHeight: '300px' }} />


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
const DUMP_TYPE_LABELS: Record<string, string> = {
  kernel: 'Kernel memory dump',
  userminidump: 'User-mode minidump',
  netmanaged: '.NET managed dump',
  unknown: 'Unknown'
};

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// Everything below is built daily from the full WinDBG corpus (aggregates only).
const CorpusInsightsSection: React.FC<{ insights: CorpusInsights }> = ({ insights }) => {
  const t = insights.totals;
  const hardwareShare = typeof t.ai_hardware_share === 'number' ? `${(t.ai_hardware_share * 100).toFixed(1)}%` : '—';
  const firstMinuteShare = t.analyses ? `${((t.crashes_within_first_minute / t.analyses) * 100).toFixed(1)}%` : '—';
  const products = insights.product_types.filter(p => p.k !== 'Unknown');
  return (
    <section className="corpus-insights" aria-labelledby="corpus-insights-title">
      <h2 id="corpus-insights-title" className="insights-heading">
        Inside {t.analyses.toLocaleString('en-US')} crash dumps
      </h2>
      <p className="insights-lede">
        Built daily from every WinDBG analysis since{' '}
        {t.since ? new Date(t.since).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'launch'}.
        {' '}Aggregates only; no dump contents or personal data are published.
      </p>

      <div className="stats-tiles">
        <StatTile label="Distinct drivers & modules" value={t.distinct_modules.toLocaleString('en-US')} />
        <StatTile label="Median uptime at crash" value={formatDuration(t.median_uptime_seconds)} />
        <StatTile label="Crashed in first minute" value={firstMinuteShare}
          hint={`${t.crashes_within_first_minute.toLocaleString('en-US')} dumps`} />
        <StatTile label="AI-judged hardware fault" value={hardwareShare} />
        <StatTile label="Median WinDBG analysis" value={formatDuration(t.median_analysis_seconds)} />
      </div>

      <WeekHourHeatmap cells={insights.utc_heatmap} />

      <div className="stats-grid">
        <ColumnHistogram
          title="How long the PC had been running"
          unit="crashes"
          bins={insights.uptime.map(u => ({ label: u.k, count: u.n }))}
          note="System uptime when the crash happened."
        />
        <ColumnHistogram
          title="CPU threads (logical processors)"
          unit="crashes"
          bins={insights.cpu_threads.map(c => ({ label: c.k, count: c.n }))}
        />
      </div>

      <div className="stats-grid">
        <BarList title="Culprit driver category (AI)" family={toFamily(insights.ai_driver_categories, capitalize)} />
        <BarList title="Culprit driver maker (AI)" family={toFamily(insights.ai_manufacturers)} max={10} />
        <BarList title="Graphics-stack crashes" family={toFamily(insights.gpu_stacks)} />
      </div>

      <div className="stats-grid">
        <SplitBar
          title="Hardware vs software cause (AI)"
          parts={[
            { label: 'Software / driver', value: insights.ai_hardware_split.software },
            { label: 'Hardware', value: insights.ai_hardware_split.hardware }
          ]}
        />
        {products.length > 1 ? (
          <SplitBar title="Workstation vs server" parts={products.map(p => ({ label: p.k, value: p.n }))} />
        ) : null}
      </div>

      <div className="stats-grid">
        <BarList title="Hardware faults by type (AI)" family={toFamily(insights.ai_hardware_types)} />
        <BarList title="Windows release" family={toFamily(insights.windows_releases)} />
        <BarList title="Dump type" family={toFamily(insights.dump_types, k => DUMP_TYPE_LABELS[k] ?? k)} />
      </div>

      <BarList title="Process running when it crashed" family={toFamily(insights.processes)} max={12} />

      <StopCodeTrends trends={insights.stop_code_trends} weeks={insights.weekly_totals} />
      <CodeModuleMatrix matrix={insights.code_module_matrix} />

      <details className="stats-table">
        <summary>View insight data as tables</summary>
        <table>
          <caption>Crashes by uptime</caption>
          <thead><tr><th scope="col">Uptime</th><th scope="col">Crashes</th></tr></thead>
          <tbody>{insights.uptime.map(u => <tr key={u.k}><td>{u.k}</td><td>{u.n}</td></tr>)}</tbody>
        </table>
        <table>
          <caption>Crashes by weekday (UTC)</caption>
          <thead><tr><th scope="col">Weekday</th><th scope="col">Crashes</th></tr></thead>
          <tbody>
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, d) => (
              <tr key={day}><td>{day}</td><td>{insights.utc_heatmap.filter(c => c.d === d).reduce((a, c) => a + c.n, 0)}</td></tr>
            ))}
          </tbody>
        </table>
        <table>
          <caption>Weekly analyses</caption>
          <thead><tr><th scope="col">Week of</th><th scope="col">Analyses</th></tr></thead>
          <tbody>{insights.weekly_totals.map(w => <tr key={w.w}><td>{w.w}</td><td>{w.n}</td></tr>)}</tbody>
        </table>
      </details>
    </section>
  );
};

export default StatsPage;
