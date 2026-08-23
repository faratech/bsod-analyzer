// AI-generated narrative for the crash-statistics page, served through the
// OpenRouter free tier. Deliberately frugal: the generated text is cached in
// Redis for hours (stats move slowly), regeneration is single-flight via a
// SETNX lock, and the prompt contains only anonymous aggregate numbers.
import { generateOpenRouterContent, DEFAULT_OPENROUTER_BASE_URL } from '../services/aiProvider.js';

const DEFAULT_TTL_SECONDS = 6 * 60 * 60;   // fresh for 6h
const LOCK_TTL_SECONDS = 120;              // concurrent-generation guard

const SYSTEM_INSTRUCTION =
  'You are a Windows crash-analysis expert writing a short public summary for a community BSOD statistics page. ' +
  'You receive anonymous aggregate counts (never user data). Reply ONLY with JSON {"insight": "..."} containing plain prose: ' +
  'no markdown, no headings, no bullet points.';

function buildDigest(snapshot) {
  const daily = snapshot.daily || [];
  const last = daily.slice(-7).reduce((s, d) => s + d.count, 0);
  const prev = daily.slice(-14, -7).reduce((s, d) => s + d.count, 0);
  return {
    totalAnalyses: snapshot.totals?.analyses,
    trackingSince: snapshot.trackingSince,
    todayUtc: snapshot.gauges?.today,
    lastHour: snapshot.gauges?.lastHour,
    weeklyVolume: { previousWeek: prev, lastWeek: last },
    topStopCodes: (snapshot.topStopCodes?.items || []).map(i => ({
      code: i.value, name: i.label, count: i.count, meaning: i.description
    })),
    otherStopCodeCount: snapshot.topStopCodes?.other,
    topFaultingModules: (snapshot.topModules?.items || []).slice(0, 6),
    windowsVersions: (snapshot.osVersions?.items || []).slice(0, 4),
    dumpTypes: snapshot.dumpTypes?.items,
    sources: snapshot.sources?.items
  };
}

export function createStatsInsightService({
  getClient,
  isEnabled = () => true,
  getSnapshot,
  now = () => Date.now(),
  provider = generateOpenRouterContent,
  apiKey = process.env.OPENROUTER_API_KEY,
  baseUrl = process.env.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE_URL,
  model = process.env.OPENROUTER_FREE_MODEL,
  ttlSeconds = DEFAULT_TTL_SECONDS
} = {}) {
  const active = () => Boolean(getClient?.()) && isEnabled() && Boolean(apiKey);

  function key(suffix) {
    return `stats:insight${suffix ? `:${suffix}` : ''}`;
  }

  async function generateInsight(snapshot) {
    const result = await provider({
      contents: `Aggregate Windows crash statistics (anonymous counts):\n` +
        JSON.stringify(buildDigest(snapshot)) +
        `\n\nWrite 2-4 sentences (max ~150 words) of plain prose for the statistics page: name what dominates, ` +
        `note any change between the previous and most recent week, and give one practical takeaway for Windows users. ` +
        `Treat driver/module names exactly as given.`,
      config: { systemInstruction: SYSTEM_INSTRUCTION, maxOutputTokens: 400, temperature: 0.4 }
    }, { apiKey, baseUrl, model });
    let parsed;
    try {
      parsed = JSON.parse(result);
    } catch {
      parsed = null;
    }
    const text = typeof parsed?.insight === 'string' && parsed.insight.trim()
      ? parsed.insight.trim().slice(0, 1200)
      : typeof result === 'string' && result.trim() ? result.trim().slice(0, 1200) : '';
    if (!text) throw new Error('insight generation produced no usable text');
    return {
      text,
      model: model || 'openrouter',
      generatedAt: new Date(now()).toISOString()
    };
  }

  // Returns {available:false} when disabled/failed; otherwise the cached or
  // freshly generated insight. Stale text is still served while regenerating.
  async function getInsight() {
    if (!active()) return { available: false };
    const redis = getClient();
    try {
      let cached = null;
      const raw = await redis.get(key());
      if (raw) {
        try {
          cached = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch { cached = null; }
      }
      const ageMs = cached ? now() - Date.parse(cached.generatedAt) : Infinity;
      if (cached && Number.isFinite(ageMs) && ageMs < ttlSeconds * 1000) {
        return { ...cached, available: true, cached: true };
      }

      const lockAcquired = await redis.set(key('lock'), '1', { nx: true, ex: LOCK_TTL_SECONDS });
      if (!lockAcquired) {
        if (cached) return { ...cached, available: true, cached: true, stale: true };
        return { available: false, generating: true };
      }
      try {
        const snapshot = await getSnapshot();
        if (!snapshot) return cached ? { ...cached, available: true, cached: true } : { available: false };
        const fresh = await generateInsight(snapshot);
        await redis.set(key(), JSON.stringify(fresh), { ex: ttlSeconds });
        return { ...fresh, available: true, cached: false };
      } finally {
        await redis.del(key('lock'));
      }
    } catch (error) {
      console.error('[Stats] insight failed:', error?.message || error);
      return { available: false };
    }
  }

  return { getInsight };
}

export function registerStatsInsightRoute(app, { service, limiter }) {
  const handler = async (_req, res) => {
    // NOTE: the compat layer's res.set() takes a headers object only.
    res.set({ 'Cache-Control': 'public, max-age=120, s-maxage=300' });
    const insight = await service.getInsight();
    res.json({ success: true, ...insight });
  };
  const args = ['/api/stats/insight'];
  if (limiter) args.push(limiter);
  args.push(handler);
  app.get(...args);
}
