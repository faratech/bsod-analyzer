// Per-route cap on in-flight expensive work (AI calls, WinDBG uploads, archive
// extraction). A slot is held until the response finishes or the handler chain
// settles, never merely until the client disconnects: the handler keeps
// working after a disconnect, so releasing on 'close' let a client that drops
// and reconnects stack unbounded work (and memory) on one instance.
import { onRequestSettled } from './fastifyCompat.js';

export function createConcurrencyLimiter(max, code, { onSettled = onRequestSettled } = {}) {
  let active = 0;
  const limiter = (req, res, next) => {
    if (active >= max) {
      return res.status(429).json({
        success: false,
        error: 'Server is busy. Please retry shortly.',
        code
      });
    }

    active++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        active = Math.max(0, active - 1);
      }
    };
    res.once('finish', release);
    onSettled(req, release);
    next();
  };
  limiter.inFlight = () => active;
  return limiter;
}
