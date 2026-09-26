// Per-instance quota accounting: per-session AI request/token quotas (issue #77)
// and the AI providers' free-tier token budgets.
//
// Neither needs a shared store to be safe. Session affinity keeps a client on
// one Cloud Run instance, so session quotas stay close to exact. Provider
// budgets are split into `shards` shares so several instances cannot overshoot
// a free tier by the instance count, and each provider's own quota errors
// latch its route off (markExhausted). Counts reset when an instance restarts,
// which hourly/daily windows tolerate.

export function createSessionQuotaStore() {
  const entries = new Map(); // quotaKey -> { requests, tokens, refunds, resetTime }

  function windowFor(quotaKey, windowSeconds, now) {
    const entry = entries.get(quotaKey);
    if (entry && now <= entry.resetTime) return entry;
    const fresh = { requests: 0, tokens: 0, refunds: 0, resetTime: now + windowSeconds * 1000 };
    entries.set(quotaKey, fresh);
    return fresh;
  }

  function liveEntry(quotaKey, now) {
    const entry = entries.get(quotaKey);
    return entry && now <= entry.resetTime ? entry : null;
  }

  // Checks both caps before incrementing either, so a request is admitted
  // only when the whole request + token bundle fits.
  function reserve(quotaKey, { requestCost = 1, tokenCost, requestLimit, tokenLimit, windowSeconds, now = Date.now() }) {
    const entry = windowFor(quotaKey, windowSeconds, now);
    const tokens = Math.max(0, Math.ceil(Number(tokenCost) || 0));
    const snapshot = () => ({ requests: entry.requests, tokens: entry.tokens, resetTime: new Date(entry.resetTime) });
    if (entry.requests + requestCost > requestLimit) return { allowed: false, reason: 'requests', ...snapshot() };
    if (entry.tokens + tokens > tokenLimit) return { allowed: false, reason: 'tokens', ...snapshot() };
    entry.requests += requestCost;
    entry.tokens += tokens;
    return { allowed: true, ...snapshot() };
  }

  // Moves the reserved token estimate toward the provider-reported actuals.
  function commit(quotaKey, { tokenDelta, now = Date.now() }) {
    const entry = liveEntry(quotaKey, now);
    if (entry) entry.tokens = Math.max(0, entry.tokens + Math.ceil(Number(tokenDelta) || 0));
  }

  // Releases a reservation after a failure that was not the client's fault;
  // capped per window so failures cannot be farmed to shift accounting back.
  function refund(quotaKey, { requestCost = 1, tokenCost, refundCap, now = Date.now() }) {
    const entry = liveEntry(quotaKey, now);
    if (!entry) return { refunded: false, refundsUsed: 0, refundCap };
    if (entry.refunds >= refundCap) return { refunded: false, refundsUsed: entry.refunds, refundCap };
    entry.refunds += 1;
    entry.requests = Math.max(0, entry.requests - requestCost);
    entry.tokens = Math.max(0, entry.tokens - Math.max(0, Math.ceil(Number(tokenCost) || 0)));
    return { refunded: true, refundsUsed: entry.refunds, refundCap };
  }

  function prune(now = Date.now()) {
    for (const [key, entry] of entries) {
      if (now > entry.resetTime) entries.delete(key);
    }
  }

  return { reserve, commit, refund, prune, size: () => entries.size };
}

function utcWindows(now) {
  const date = new Date(now);
  const day = date.toISOString().slice(0, 10).replaceAll('-', '');
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  const h = date.getUTCHours();
  return {
    day,
    hour: `${day}${String(h).padStart(2, '0')}`,
    dayEnd: Date.UTC(y, m, d + 1),
    hourEnd: Date.UTC(y, m, d, h + 1)
  };
}

export function createProviderQuotaStore({ shards = 1 } = {}) {
  const shardCount = Math.max(1, Math.floor(Number(shards) || 1));
  // Day and hour usage live in separate buckets, each expiring with its own
  // UTC window: `${provider}:day:<yyyymmdd>` / `${provider}:hour:<yyyymmddhh>`.
  const usage = new Map(); // key -> { input, output, expiresAt }
  const exhaustedUntil = new Map(); // `${provider}:${scope}` -> epoch ms

  const share = limit => Math.floor(Math.max(0, Number(limit) || 0) / shardCount);

  function bucket(key, expiresAt) {
    let entry = usage.get(key);
    if (!entry) {
      entry = { input: 0, output: 0, expiresAt };
      usage.set(key, entry);
    }
    return entry;
  }

  function isExhausted(provider, now = Date.now()) {
    return ['day', 'hour'].some(scope => (exhaustedUntil.get(`${provider}:${scope}`) || 0) > now);
  }

  // Latch a provider off until the end of the current UTC hour or day.
  function markExhausted(provider, scope, now = Date.now()) {
    const windows = utcWindows(now);
    exhaustedUntil.set(`${provider}:${scope}`, scope === 'hour' ? windows.hourEnd : windows.dayEnd);
  }

  function reserve(provider, {
    inputCost,
    outputCost,
    dailyInputLimit,
    dailyOutputLimit,
    hourlyInputLimit,
    hourlyOutputLimit,
    now = Date.now()
  } = {}) {
    const input = Math.max(0, Math.ceil(Number(inputCost) || 0));
    const output = Math.max(0, Math.ceil(Number(outputCost) || 0));
    const limits = {
      dayInput: share(dailyInputLimit),
      dayOutput: share(dailyOutputLimit),
      hourInput: share(hourlyInputLimit),
      hourOutput: share(hourlyOutputLimit)
    };
    if (!provider || !Object.values(limits).every(value => value > 0)) {
      return { allowed: false, reason: 'invalid', provider };
    }
    if (isExhausted(provider, now)) return { allowed: false, reason: 'exhausted', provider };

    const windows = utcWindows(now);
    const day = bucket(`${provider}:day:${windows.day}`, windows.dayEnd);
    const hour = bucket(`${provider}:hour:${windows.hour}`, windows.hourEnd);
    if (day.input + input > limits.dayInput || day.output + output > limits.dayOutput) {
      return { allowed: false, reason: 'daily', provider };
    }
    if (hour.input + input > limits.hourInput || hour.output + output > limits.hourOutput) {
      return { allowed: false, reason: 'hourly', provider };
    }
    day.input += input;
    day.output += output;
    hour.input += input;
    hour.output += output;
    return {
      allowed: true,
      provider,
      window: { day: windows.day, hour: windows.hour },
      reservedInput: input,
      reservedOutput: output
    };
  }

  // Adjust a reservation toward actual usage (negative deltas release it).
  function adjust(reservation, { inputDelta = 0, outputDelta = 0 } = {}) {
    if (!reservation?.allowed || !reservation.window) return;
    const { provider, window } = reservation;
    for (const key of [`${provider}:day:${window.day}`, `${provider}:hour:${window.hour}`]) {
      const entry = usage.get(key);
      if (!entry) continue;
      entry.input = Math.max(0, entry.input + Math.trunc(Number(inputDelta) || 0));
      entry.output = Math.max(0, entry.output + Math.trunc(Number(outputDelta) || 0));
    }
  }

  function prune(now = Date.now()) {
    for (const [key, entry] of usage) {
      if (entry.expiresAt <= now) usage.delete(key);
    }
    for (const [key, until] of exhaustedUntil) {
      if (until <= now) exhaustedUntil.delete(key);
    }
  }

  return { reserve, adjust, markExhausted, isExhausted, prune, shardCount };
}

/**
 * Settle a reservation only when the provider supplied a positive usage
 * value. Missing usage must retain the original upper-bound reservation.
 */
export function settleProviderTokenReservation(reservation, {
  inputTokens,
  outputTokens
} = {}) {
  if (!reservation?.allowed) return null;
  const reportedInput = Number(inputTokens);
  const reportedOutput = Number(outputTokens);
  const inputKnown = Number.isFinite(reportedInput) && reportedInput > 0;
  const outputKnown = Number.isFinite(reportedOutput) && reportedOutput > 0;
  const actualInput = inputKnown ? Math.floor(reportedInput) : reservation.reservedInput;
  const actualOutput = outputKnown ? Math.floor(reportedOutput) : reservation.reservedOutput;
  return {
    actualInput,
    actualOutput,
    inputDelta: actualInput - reservation.reservedInput,
    outputDelta: actualOutput - reservation.reservedOutput,
    usageEstimated: !inputKnown || !outputKnown
  };
}
