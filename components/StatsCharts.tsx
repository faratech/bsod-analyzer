// Dependency-free chart primitives for the crash-statistics pages.
// Design notes follow the dataviz method: headline numbers live in tiles,
// magnitude comparisons use a single hue (identity comes from row labels, so
// bar lists never rainbow-color categories), the only multi-series form is the
// split bar (two validated hues + 2px surface gaps + inline labels), text
// always wears text tokens, and every chart has an accessible table fallback
// or aria-labels.
import React from 'react';

export const CHART_SECONDARY = '#0d9488'; // validated vs --brand-primary on #111111 and #ffffff

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

interface StatTileProps {
  label: string;
  value?: number | string;
  hint?: string;
}

export const StatTile: React.FC<StatTileProps> = ({ label, value, hint }) => (
  <div className="stat-tile">
    <span className="stat-tile-label">{label}</span>
    <span className="stat-tile-value">{value ?? '—'}</span>
    {hint ? <span className="stat-tile-hint">{hint}</span> : null}
  </div>
);

interface BarListProps {
  title: string;
  family: { items: { value: string; label?: string; count: number }[]; other: number; total: number };
  max?: number;
}

// Horizontal magnitude list: one hue, sorted desc, top N rows plus an
// "Other" fold so long tails stay honest about what is not shown.
export const BarList: React.FC<BarListProps> = ({ title, family, max = 8 }) => {
  const items = family.items.slice(0, max);
  const shownTotal = items.reduce((sum, item) => sum + item.count, 0);
  const otherCount = Math.max(0, family.total - shownTotal);
  const peak = Math.max(1, ...items.map(item => item.count));
  return (
    <section className="bar-list" aria-label={title}>
      <h3 className="chart-title">{title}</h3>
      {family.total === 0 ? (
        <p className="chart-empty">No data yet.</p>
      ) : (
        <ul>
          {items.map((item, index) => (
            <li key={item.value} className={index === 0 ? 'is-top' : undefined}>
              <div className="bar-list-head">
                <span className="bar-list-label">{item.label || item.value}</span>
                <span className="bar-list-count">{formatCount(item.count)}</span>
              </div>
              <div
                className="bar-list-track"
                role="img"
                aria-label={`${item.label || item.value}: ${formatCount(item.count)} analyses`}
              >
                <div className="bar-list-fill" style={{ width: `${Math.max(2, (item.count / peak) * 100)}%` }} />
              </div>
            </li>
          ))}
          {otherCount > 0 ? (
            <li className="bar-list-other">
              <span className="bar-list-label">Other</span>
              <span className="bar-list-count">{formatCount(otherCount)}</span>
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
};

interface DailyVolumeChartProps {
  daily: { date: string; count: number }[];
}

function formatDateLabel(date: string): string {
  // YYYYMMDD -> "Aug 23"
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  });
}

// One column per day, zero days included as baseline ticks (missing != absent).
// Pure CSS columns keep crisp edges at any width; the tooltip is CSS-only.
export const DailyVolumeChart: React.FC<DailyVolumeChartProps> = ({ daily }) => {
  if (!daily.length) return <p className="chart-empty">No data yet.</p>;
  const peak = Math.max(1, ...daily.map(d => d.count));
  const tickEvery = Math.max(1, Math.round(daily.length / 5));
  return (
    <section className="daily-chart" aria-label="Analyses per day, last 90 days">
      <h3 className="chart-title">Analyses per day</h3>
      <div className="daily-chart-plot" role="img" aria-label={`Daily analyses over the last ${daily.length} days, peak ${formatCount(peak)} per day`}>
        {daily.map((d) => (
          <div
            key={d.date}
            className={d.count === 0 ? 'day-col is-zero' : 'day-col'}
            style={{ height: d.count === 0 ? undefined : `${Math.max(3, (d.count / peak) * 100)}%` }}
            data-tip={`${formatDateLabel(d.date)}: ${formatCount(d.count)}`}
          />
        ))}
      </div>
      <div className="daily-chart-ticks" aria-hidden="true">
        {daily.map((d, i) => (i % tickEvery === 0 ? <span key={d.date}>{formatDateLabel(d.date)}</span> : null))}
      </div>
    </section>
  );
};

interface SplitBarProps {
  title: string;
  parts: { label: string; value: number }[];
}

// Two-segment stacked split (brand + secondary hue, 2px surface gaps, inline
// labels). Segments below ~1/12th of the bar fold into the label line only.
export const SplitBar: React.FC<SplitBarProps> = ({ title, parts }) => {
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  const colors = ['var(--brand-primary)', 'var(--chart-secondary)'];
  return (
    <section className="split-bar" aria-label={title}>
      <h3 className="chart-title">{title}</h3>
      {total === 0 ? (
        <p className="chart-empty">No data yet.</p>
      ) : (
        <>
          <div
            className="split-bar-track"
            role="img"
            aria-label={parts.map(p => `${p.label} ${Math.round((p.value / total) * 100)}%`).join(', ')}
          >
            {parts.map((part, i) => (
              part.value > 0 ? (
                <div
                  key={part.label}
                  className={i === 0 ? 'split-bar-seg is-primary' : 'split-bar-seg'}
                  style={{ flexGrow: part.value }}
                  data-tip={`${part.label}: ${formatCount(part.value)} (${Math.round((part.value / total) * 100)}%)`}
                >
                  {(part.value / total) >= 0.08 ? (
                    <span>{Math.round((part.value / total) * 100)}%</span>
                  ) : null}
                </div>
              ) : null
            ))}
          </div>
          <div className="split-bar-legend">
            {parts.map((part, i) => (
              <span key={part.label} className="split-bar-key">
                <i style={{ background: colors[i % colors.length] }} aria-hidden="true" />
                {part.label} · {formatCount(part.value)}
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
};
