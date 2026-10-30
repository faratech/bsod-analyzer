// One deadline for a whole AI provider chain (issue #255).
//
// generateAIContent() can fall through several provider legs, each with its
// own timeout (120 s each). Without a shared budget a single
// leg outlives Cloudflare's 100 s origin timeout and a chain of legs outlives
// Cloud Run's 300 s request timeout, while the handler keeps spending quota
// for a response nobody receives. Every leg here runs for at most
// min(its own timeout, what remains of the request budget), a leg is not
// started when less than a useful minimum remains, and the in-flight call is
// aborted (not only abandoned, #208) when its time runs out. A leg that is not
// the last in the chain (`nonFinal`) also leaves the final leg a reserve, so a
// stalled early provider falls through instead of spending the whole budget
// (issue #272).
import { AIProviderError } from '../services/aiProvider.js';
import { parsePositiveIntEnv } from './envConfig.js';

// Under Cloudflare's 100 s proxy read timeout, with room for the response.
export const DEFAULT_AI_REQUEST_DEADLINE_MS = 90_000;
// A leg with less than this left cannot produce an analysis; skip it.
export const DEFAULT_AI_MIN_LEG_MS = 5_000;
// Kept back from every non-final leg for the chain's final leg (DeepSeek).
export const DEFAULT_AI_FINAL_RESERVE_MS = 30_000;

export function aiRequestDeadlineMs(env = process.env, options = {}) {
  return parsePositiveIntEnv(env, 'AI_REQUEST_DEADLINE_MS', DEFAULT_AI_REQUEST_DEADLINE_MS, options);
}

export function createAIDeadline({
  budgetMs = DEFAULT_AI_REQUEST_DEADLINE_MS,
  minLegMs = DEFAULT_AI_MIN_LEG_MS,
  finalReserveMs,
  now = () => Date.now()
} = {}) {
  const budget = Math.max(0, Number(budgetMs) || 0);
  const expiresAt = now() + budget;
  // At most a third of a shorter budget, so early legs still get a turn.
  const reserveMs = Math.max(0, Number(finalReserveMs ?? Math.min(DEFAULT_AI_FINAL_RESERVE_MS, budget / 3)) || 0);

  const remainingMs = () => Math.max(0, expiresAt - now());
  const availableMs = ({ nonFinal = false } = {}) => Math.max(0, remainingMs() - (nonFinal ? reserveMs : 0));
  const canStart = (options = {}) => availableMs(options) >= minLegMs;
  const legTimeoutMs = (legMs, options = {}) => Math.max(0, Math.min(Number(legMs) || 0, availableMs(options)));

  // Retryable 504: classified as a refundable timeout (server/quotaPolicy.js),
  // so the session reservation is refunded. Raised only before a leg starts,
  // so no provider ran it.
  const timeoutError = () => new AIProviderError('AI request deadline exceeded', {
    code: 'AI_TIMEOUT',
    status: 504,
    retryable: true,
    notProcessed: true
  });

  // Runs one provider leg: operation(signal) gets a signal aborted when the
  // leg's capped time runs out, and the leg rejects with Error(message) then
  // (the "timed out" wording the chain's catch blocks already map to
  // AI_TIMEOUT). Throws timeoutError() without starting the leg when too
  // little of the budget remains. `{ nonFinal: true }` marks a leg the chain
  // can fall through from: it may not use the final leg's reserve.
  async function runLeg(legMs, operation, message, options = {}) {
    if (!canStart(options)) throw timeoutError();
    const ms = legTimeoutMs(legMs, options);
    const controller = new AbortController();
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(message));
        controller.abort();
      }, ms);
      timer.unref?.();
    });
    const pending = Promise.resolve().then(() => operation(controller.signal));
    pending.catch(() => {});
    try {
      return await Promise.race([pending, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  return { remainingMs, canStart, legTimeoutMs, timeoutError, runLeg };
}
