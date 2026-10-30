// Load-independent linear-time checks for the ReDoS / backtracking tests.
//
// A fixed wall-clock budget ("under 500 ms") fails whenever the machine is
// busy: the suite running next to five other copies made a linear 100 KB
// scan take 1.3 s. What these tests guard against is super-linear growth, so
// compare the time for an input against the time for one `factor` times
// smaller, measured back to back (interleaved, best of `reps`) so both see the
// same load. Linear work scales by about `factor`, quadratic by `factor`
// squared; the default bound (3 x factor) sits well between the two.
import assert from 'node:assert/strict';

function timeOnce(fn, input) {
  const started = performance.now();
  fn(input);
  return performance.now() - started;
}

// makeInput(scale) builds the input at `scale` (the full-size input is
// makeInput(factor), the baseline makeInput(1)). floorMs keeps millisecond
// baselines, where a GC pause or a descheduled slice outweighs the work, from
// turning into huge ratios: a full-size run under maxRatio x floorMs (240 ms
// by default) always passes, while the quadratic cases these tests guard
// take seconds to hours at full size.
export function assertScalesLinearly(label, fn, makeInput, { factor = 8, reps = 5, maxRatio = 3 * factor, floorMs = 10 } = {}) {
  const small = makeInput(1);
  const large = makeInput(factor);
  fn(small); // warm up (JIT, regexp compilation) outside the measurement
  let smallMs = Infinity;
  let largeMs = Infinity;
  for (let i = 0; i < reps; i++) {
    smallMs = Math.min(smallMs, timeOnce(fn, small));
    largeMs = Math.min(largeMs, timeOnce(fn, large));
  }
  const ratio = largeMs / Math.max(smallMs, floorMs);
  assert.ok(
    ratio < maxRatio,
    `${label}: ${factor}x the input took ${ratio.toFixed(1)}x the time (${smallMs.toFixed(1)} ms -> ${largeMs.toFixed(1)} ms; linear is about ${factor}x, quadratic ${factor * factor}x)`
  );
}
