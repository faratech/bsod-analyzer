interface FirstMinuteTotals {
  analyses: number;
  /** Rows with a known uptime; absent in exports older than the field. */
  uptime_known?: number | null;
  crashes_within_first_minute: number;
}

/**
 * Share of crashes within the first minute of uptime, as a fraction. The count
 * only covers dumps with a known uptime, so it divides by that count (the same
 * basis as the uptime histogram and the per-code priors); exports that predate
 * `uptime_known` fall back to all analyses. Null when there is nothing to
 * divide by.
 */
export function firstMinuteShare(totals: FirstMinuteTotals): number | null {
  const denominator = typeof totals.uptime_known === 'number' ? totals.uptime_known : totals.analyses;
  return denominator > 0 ? totals.crashes_within_first_minute / denominator : null;
}
