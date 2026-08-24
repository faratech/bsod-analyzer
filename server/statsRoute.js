// Public crash-statistics endpoint: GET /api/stats.
// Serves the Redis-cached snapshot (building it once on a cold miss) with a
// strong ETag + CDN-friendly caching so Cloudflare absorbs most reads.
import { createHash } from 'node:crypto';

const CACHE_CONTROL = 'public, max-age=60, s-maxage=300, stale-while-revalidate=600';

function strongEtag(body) {
  return `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
}

export function registerStatsRoute(app, { store, limiter } = {}) {
  const handler = async (req, res) => {
    let snapshot = null;
    try {
      snapshot = await store?.getSnapshot();
      if (!snapshot) snapshot = await store?.buildSnapshot();
    } catch (error) {
      console.error('[Stats] route read failed:', error?.message || error);
    }

    if (!snapshot) {
      res.set({ 'Cache-Control': 'no-store' });
      return res.status(503).json({ success: false, error: 'Statistics temporarily unavailable.', code: 'STATS_UNAVAILABLE' });
    }

    const body = JSON.stringify(snapshot);
    const etag = strongEtag(body);
    // NOTE: the compat layer's res.set() takes a headers object only.
    res.set({ 'Cache-Control': CACHE_CONTROL, 'ETag': etag });

    if (req.headers['if-none-match'] === etag) {
      return res.status(304).send();
    }
    res.type('application/json; charset=utf-8').send(body);
  };

  const args = ['/api/stats'];
  if (limiter) args.push(limiter);
  args.push(handler);
  app.get(...args);
}
