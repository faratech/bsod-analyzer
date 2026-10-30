import { isOpenAIFreeTier } from '../services/aiProvider.js';

// What one OpenAI free-tier attempt cost (issue #258): the tokens to add to the
// local tally and whether billed-tier traffic was served, read from either a
// returned response or a thrown error (an empty completion is billed too, so
// the adapter attaches serviceTier/usageMetadata to its error).
export function openAIFreeUsage(responseOrError) {
  const tier = typeof responseOrError?.serviceTier === 'string' ? responseOrError.serviceTier : null;
  const total = Number(responseOrError?.usageMetadata?.totalTokenCount);
  const free = isOpenAIFreeTier(tier);
  return {
    used: Number.isFinite(total) && total > 0 ? Math.floor(total) : 0,
    serviceTier: tier,
    free,
    // An absent tier is not evidence either way here (see #211).
    billed: tier !== null && !free
  };
}

function utcDayKey(date) {
  return date.toISOString().slice(0, 10);
}

// This instance's view of today's OpenAI free-tier spend (issue #291). The
// org-wide Usage API total is cached for minutes, so the gate projects
//   orgUsed + (localUsed - localAtRefresh) + inFlight + estimate
// where localAtRefresh is the local tally when that read started (tokens
// recorded during the read are counted twice, which errs on the safe side) and
// inFlight is the estimate of every request admitted but not yet recorded.
// Without a usable org total for today it falls back to the local tally plus
// in-flight against this instance's shard of the threshold.
export function createOpenAIFreeBudget({
  dailyCap,
  safetyBuffer,
  shards = 1,
  now = () => new Date()
} = {}) {
  const threshold = dailyCap - safetyBuffer;
  const shardCount = Number.isFinite(shards) && shards >= 1 ? shards : 1;
  const tally = { day: '', used: 0 };
  let org = null; // { day, used, localAtRefresh }
  let inFlight = 0;
  const open = new Set();

  function localUsed() {
    return tally.day === utcDayKey(now()) ? tally.used : 0;
  }

  function recordTokens(tokens) {
    const n = Number(tokens);
    if (!Number.isFinite(n) || n <= 0) return;
    const day = utcDayKey(now());
    if (tally.day !== day) {
      tally.day = day;
      tally.used = 0;
    }
    tally.used += n;
  }

  // Record a Usage API read; null (unavailable) clears it.
  function setOrgUsage(used, localAtRefresh = localUsed()) {
    const n = Number(used);
    org = used === null || used === undefined || !Number.isFinite(n)
      ? null
      : { day: utcDayKey(now()), used: n, localAtRefresh: Number(localAtRefresh) || 0 };
  }

  function currentOrg() {
    return org && org.day === utcDayKey(now()) ? org : null;
  }

  function projected(estimatedTokens = 0) {
    const estimate = Math.max(0, Number(estimatedTokens) || 0);
    const local = localUsed();
    const current = currentOrg();
    if (current) {
      return current.used + Math.max(0, local - current.localAtRefresh) + inFlight + estimate;
    }
    return local + inFlight + estimate;
  }

  function limit() {
    return currentOrg() ? threshold : threshold / shardCount;
  }

  // Admit a request and hold its estimate until release(); null when the
  // projection would cross the threshold.
  function tryReserve(estimatedTokens) {
    const tokens = Math.max(0, Number(estimatedTokens) || 0);
    if (projected(tokens) > limit()) return null;
    const reservation = { tokens };
    inFlight += tokens;
    open.add(reservation);
    return reservation;
  }

  function release(reservation) {
    if (!reservation || !open.delete(reservation)) return;
    inFlight = Math.max(0, inFlight - reservation.tokens);
  }

  return { localUsed, recordTokens, setOrgUsage, projected, tryReserve, release };
}
