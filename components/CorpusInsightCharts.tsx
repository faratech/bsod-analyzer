// Corpus-insight charts for /stats, following the same dataviz rules as
// StatsCharts.tsx: one hue (--brand-primary) for magnitude, a single
// light->dark sequential ramp of that hue for the heatmaps, identity carried by
// row/column labels (never by color), CSS-only hover tips, and aria labels plus
// table fallbacks so nothing is color-only.
import React from 'react';
import type { CorpusInsights, KeyCount } from '../services/statsService';
import type { RankedFamily } from '../services/statsService';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAY_NAMES = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];

export function formatCount(value: number | null | undefined): string {
  return typeof value === 'number' ? value.toLocaleString('en-US') : '—';
}

export function formatDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86400).toFixed(1)} days`;
}

export function toFamily(pairs: KeyCount[] | undefined, label?: (k: string) => string): RankedFamily {
  const items = (pairs ?? []).map(p => ({ value: p.k, label: label ? label(p.k) : p.k, count: p.n }));
  return { items, other: 0, total: items.reduce((sum, i) => sum + i.count, 0) };
}

// Quantize to 5 steps of one hue; step 0 is "no data".
function rampStep(value: number, peak: number, scale: 'linear' | 'sqrt' = 'linear'): number {
  if (value <= 0 || peak <= 0) return 0;
  const ratio = scale === 'sqrt' ? Math.sqrt(value / peak) : value / peak;
  return Math.min(5, Math.max(1, Math.ceil(ratio * 5)));
}

interface ColumnHistogramProps {
  title: string;
  bins: { label: string; count: number }[];
  unit: string;
  note?: string;
}

// Ordered bins (a histogram), one hue, category labels under every column.
export const ColumnHistogram: React.FC<ColumnHistogramProps> = ({ title, bins, unit, note }) => {
  const total = bins.reduce((sum, b) => sum + b.count, 0);
  const peak = Math.max(1, ...bins.map(b => b.count));
  return (
    <section className="col-hist" aria-label={title}>
      <h3 className="chart-title">{title}</h3>
      {total === 0 ? <p className="chart-empty">No data yet.</p> : (
        <>
          <div className="col-hist-plot" role="img"
            aria-label={bins.map(b => `${b.label}: ${formatCount(b.count)} ${unit}`).join('; ')}>
            {bins.map(b => (
              <div key={b.label} className="col-hist-col">
                <span className="col-hist-value">{Math.round((b.count / total) * 100)}%</span>
                <div
                  className="col-hist-bar"
                  style={{ height: `${Math.max(2, (b.count / peak) * 100)}%` }}
                  data-tip={`${b.label}: ${formatCount(b.count)} ${unit} (${Math.round((b.count / total) * 100)}%)`}
                />
              </div>
            ))}
          </div>
          <div className="col-hist-labels" aria-hidden="true">
            {bins.map(b => <span key={b.label}>{b.label}</span>)}
          </div>
          {note ? <p className="chart-note">{note}</p> : null}
        </>
      )}
    </section>
  );
};

interface WeekHourHeatmapProps {
  cells: CorpusInsights['utc_heatmap'];
}

// 7 x 24 grid (UTC), sequential single-hue ramp, row/column labels carry identity.
export const WeekHourHeatmap: React.FC<WeekHourHeatmapProps> = ({ cells }) => {
  const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const c of cells) {
    if (c.d >= 0 && c.d < 7 && c.h >= 0 && c.h < 24) grid[c.d][c.h] += c.n;
  }
  const peak = Math.max(0, ...grid.flat());
  if (peak === 0) return <p className="chart-empty">No data yet.</p>;
  const byDay = grid.map(row => row.reduce((a, b) => a + b, 0));
  const byHour = Array.from({ length: 24 }, (_, h) => grid.reduce((sum, row) => sum + row[h], 0));
  const busiestDayIndex = byDay.indexOf(Math.max(...byDay));
  const busiestDay = WEEKDAYS[busiestDayIndex];
  const busiestHour = byHour.indexOf(Math.max(...byHour));
  return (
    <section className="heatmap" aria-label="Crashes by weekday and hour (UTC)">
      <h3 className="chart-title">When crashes happen <span className="chart-sub">weekday × hour, UTC</span></h3>
      <div className="heatmap-grid" role="img"
        aria-label={`Crash counts by weekday and UTC hour. Busiest day ${busiestDay}, busiest hour ${busiestHour}:00 UTC.`}>
        <span className="heatmap-corner" aria-hidden="true" />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={`h${h}`} className="heatmap-hour" aria-hidden="true">{h % 6 === 0 ? `${h}` : ''}</span>
        ))}
        {grid.map((row, d) => (
          <React.Fragment key={WEEKDAYS[d]}>
            <span className="heatmap-day" aria-hidden="true">{WEEKDAYS[d]}</span>
            {row.map((n, h) => (
              <span
                key={`${d}-${h}`}
                className={`heatmap-cell step-${rampStep(n, peak)}`}
                data-tip={`${WEEKDAYS[d]} ${String(h).padStart(2, '0')}:00 UTC: ${formatCount(n)}`}
              />
            ))}
          </React.Fragment>
        ))}
      </div>
      <div className="ramp-legend" aria-hidden="true">
        <span>Fewer</span>
        {[1, 2, 3, 4, 5].map(s => <i key={s} className={`heatmap-cell step-${s}`} />)}
        <span>More</span>
      </div>
      <p className="chart-note">
        Busiest: {WEEKDAY_NAMES[busiestDayIndex]} and {String(busiestHour).padStart(2, '0')}:00 UTC. Times are when the crash happened, converted to UTC.
      </p>
    </section>
  );
};

interface MatrixProps {
  matrix: CorpusInsights['code_module_matrix'];
}

// Stop code x faulting module counts: direct labels in every non-empty cell,
// single-hue ramp for magnitude.
export const CodeModuleMatrix: React.FC<MatrixProps> = ({ matrix }) => {
  const lookup = new Map(matrix.cells.map(c => [`${c.c}|${c.m}`, c.n]));
  const peak = Math.max(0, ...matrix.cells.map(c => c.n));
  if (!matrix.codes.length || !matrix.modules.length || peak === 0) return null;
  return (
    <section className="matrix" aria-label="Stop codes by faulting module">
      <h3 className="chart-title">Stop code × faulting module <span className="chart-sub">crash counts, shading on a square-root scale</span></h3>
      <div className="matrix-scroll">
        <table className="matrix-table">
          <caption className="sr-only">Crash counts by stop code (rows) and faulting module (columns)</caption>
          <thead>
            <tr>
              <th scope="col"><span className="sr-only">Stop code</span></th>
              {matrix.modules.map(m => <th key={m} scope="col" title={m}><span>{m.replace(/\.sys$/, '')}</span></th>)}
            </tr>
          </thead>
          <tbody>
            {matrix.codes.map(code => (
              <tr key={code}>
                <th scope="row">{code}</th>
                {matrix.modules.map(m => {
                  const n = lookup.get(`${code}|${m}`) ?? 0;
                  const step = rampStep(n, peak, 'sqrt');
                  return (
                    <td key={m} className={`heatmap-cell step-${step}${step >= 3 ? ' is-strong' : ''}`}
                      data-tip={`${code} with ${m}: ${formatCount(n)}`}>
                      {n > 0 ? formatCount(n) : ''}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};

interface TrendsProps {
  trends: CorpusInsights['stop_code_trends'];
  weeks: CorpusInsights['weekly_totals'];
}

// Small multiples: one 2px line per stop code on a shared week axis, each with
// its own y-scale (compare shapes, not heights). Hover a week for its count.
export const StopCodeTrends: React.FC<TrendsProps> = ({ trends, weeks }) => {
  // Drop the first and last weeks: the corpus starts mid-week and the current
  // week is still in progress, so both would read as false dips.
  const axis = weeks.map(w => w.w).slice(1, -1);
  if (!trends.length || axis.length < 2) return null;
  const W = 240;
  const H = 56;
  const label = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return (
    <section className="trends" aria-label="Weekly trend of the most common stop codes">
      <h3 className="chart-title">Top stop codes, week by week <span className="chart-sub">complete weeks, each panel on its own scale</span></h3>
      <div className="trends-grid">
        {trends.map(t => {
          const counts = new Map(t.weeks.map(w => [w.w, w.n]));
          const series = axis.map(w => counts.get(w) ?? 0);
          const peak = Math.max(1, ...series);
          const x = (i: number) => (i / (axis.length - 1)) * W;
          const y = (n: number) => H - 4 - (n / peak) * (H - 8);
          const path = series.map((n, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(n).toFixed(1)}`).join(' ');
          const total = series.reduce((a, b) => a + b, 0);
          return (
            <figure key={t.code} className="trend-panel">
              <figcaption>
                <span className="trend-code">{t.code}</span>
                {t.name ? <span className="trend-name">{t.name}</span> : null}
                <span className="trend-total" title="Total over the plotted weeks">{formatCount(total)}</span>
              </figcaption>
              <svg viewBox={`0 0 ${W} ${H}`} role="img"
                aria-label={`${t.code}: ${series.map((n, i) => `${label(axis[i])} ${n}`).join(', ')}`}>
                <path d={path} className="trend-line" />
                {series.map((n, i) => (
                  <g key={axis[i]} className="trend-hit">
                    <rect x={x(i) - W / axis.length / 2} y={0} width={W / axis.length} height={H} />
                    <circle cx={x(i)} cy={y(n)} r={4} />
                    <title>{`Week of ${label(axis[i])}: ${formatCount(n)}`}</title>
                  </g>
                ))}
              </svg>
            </figure>
          );
        })}
      </div>
      <div className="trends-axis" aria-hidden="true">
        <span>{label(axis[0])}</span>
        <span>{label(axis[axis.length - 1])}</span>
      </div>
    </section>
  );
};
