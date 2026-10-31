// BSOD AI chat routes: ask a question about a crash that was just analyzed.
//
//   GET  /api/bsod-ai/status  whether the chat is on, and whether this session has a pass
//   POST /api/bsod-ai/pass    Turnstile (action "bsod-ai") -> a short-lived signed pass cookie
//   POST /api/bsod-ai/ask     one question; needs the session, the pass, the data-use terms
//
// Everything the route touches arrives through `deps`, so tests/bsodAiRoute.test.mjs
// drives it with fakes. The pure rules live in server/bsodAi.js. The AI call is
// `deps.generateChat`: free providers only, never a billed fallback.
import {
  LIMITS, REPLIES, SYSTEM_INSTRUCTION,
  normalizeQuestion, normalizeHistory, normalizeReport, screenQuestion,
  buildCaseFile, buildChatContents, parseChatAnswer,
} from './bsodAi.js';

export const PASS_COOKIE = 'bsod_ai_pass';
const HASH_RE = /^[a-f0-9]{64}$/i;
const MODEL = 'gpt-6-luna';
// One address may carry this many sessions' worth of questions (see the quota below).
const ADDRESS_ALLOWANCE = 3;

export function registerBsodAiRoutes(app, deps) {
  const {
    enabled = false,
    middlewares = {},
    passCodec,
    strikes,
    verifyTurnstile,
    turnstileAction = 'bsod-ai',
    hostnameAllowed = () => false,
    allowedHosts = [],
    quotaLedger,
    tierLimits,
    wfSsoEnabled = false,
    globalDailyLimit = 0,
    sessionOwnsHash = () => false,
    loadEvidence = async () => null,
    generateChat,
    createDeadline = () => undefined,
    redact = value => value,
    rateLimitKey = () => 'unknown',
    safeToken = value => String(value).slice(0, 8),
    log = { info() {}, warn() {}, error() {} },
    production = false,
    now = Date.now,
  } = deps;

  const inFlight = new Set();
  const list = name => middlewares[name] || [];

  // The routes carry session cookies, so a request from another site must never
  // spend them. Fetch Metadata where the browser sends it, Origin otherwise.
  function sameOrigin(req, res, next) {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin') return res.status(403).json({ success: false, code: 'CROSS_SITE', error: 'Cross-site request refused.' });
    const origin = req.headers.origin;
    if (origin) {
      let host = '';
      try { host = new URL(origin).host; } catch { /* refused below */ }
      if (!host || ![req.headers.host, ...allowedHosts].includes(host)) {
        return res.status(403).json({ success: false, code: 'CROSS_SITE', error: 'Cross-site request refused.' });
      }
    }
    return next();
  }

  const strikeKeys = req => [`sess:${req.sessionId}`, `ip:${rateLimitKey(req)}`];
  const lockedReply = (res, state) => {
    res.set({ 'Retry-After': String(Math.max(1, Math.ceil(state.retryAfterMs / 1000))) });
    return res.status(429).json({ success: false, code: 'BSOD_AI_LOCKED', error: 'BSOD AI is taking a break after too many odd questions. Try again later.', retryAfterMs: state.retryAfterMs });
  };
  const hasPass = req => passCodec.verify(req.cookies?.[PASS_COOKIE], req.sessionId);

  // ---- status -------------------------------------------------------------
  app.get('/api/bsod-ai/status', ...list('status'), (req, res) => {
    res.set({ 'Cache-Control': 'no-store' });
    if (!enabled) return res.json({ enabled: false });
    const limits = tierLimits(wfSsoEnabled ? (req.tier || 'anon') : 'anon');
    return res.json({ enabled: true, pass: Boolean(hasPass(req)), limit: limits.requests, windowMinutes: 60, model: MODEL });
  });

  // Switched off: nothing below is mounted with its limiters, so a disabled chat
  // costs no shared-store command and answers one thing.
  if (!enabled) {
    const off = (req, res) => res.status(503).json({ success: false, code: 'BSOD_AI_DISABLED', error: 'BSOD AI is not available right now.' });
    app.post('/api/bsod-ai/pass', off);
    app.post('/api/bsod-ai/ask', off);
    return;
  }

  // ---- pass ---------------------------------------------------------------
  app.post('/api/bsod-ai/pass', sameOrigin, ...list('pass'), async (req, res) => {
    const lock = strikes.check(strikeKeys(req));
    if (lock.locked) return lockedReply(res, lock);
    const { token, action } = req.body || {};
    if (typeof token !== 'string' || !token || token.length > 4096 || action !== turnstileAction) {
      return res.status(400).json({ success: false, code: 'BAD_REQUEST', error: 'Security verification failed.' });
    }
    const verification = await verifyTurnstile(token, req.clientIp || rateLimitKey(req));
    if (!verification?.success) {
      return res.status(400).json({ success: false, code: 'TURNSTILE_FAILED', error: 'Security verification failed. Try again.', 'error-codes': verification?.['error-codes'] });
    }
    // The token proves a challenge was solved, not which widget solved it: the
    // action ties it to this feature, the hostname to this site.
    if (verification.action !== turnstileAction || (production && !verification.hostname) || (verification.hostname && !hostnameAllowed(verification.hostname))) {
      log.warn('bsod_ai.pass_mismatch', { action: verification.action, hostname: verification.hostname });
      return res.status(400).json({ success: false, code: 'TURNSTILE_MISMATCH', error: 'Security verification failed.' });
    }
    res.cookie(PASS_COOKIE, passCodec.issue(req.sessionId), {
      httpOnly: true, secure: production, sameSite: 'strict', path: '/api/bsod-ai', maxAge: passCodec.ttlMs,
    });
    return res.json({ success: true, expiresInSeconds: Math.floor(passCodec.ttlMs / 1000) });
  });

  // ---- ask ----------------------------------------------------------------
  app.post('/api/bsod-ai/ask', sameOrigin, ...list('ask'), async (req, res) => {
    const started = now();
    const keys = strikeKeys(req);
    const lock = strikes.check(keys);
    if (lock.locked) return lockedReply(res, lock);
    if (!hasPass(req)) {
      return res.status(403).json({ success: false, code: 'AI_PASS_REQUIRED', error: 'Complete the security check to ask BSOD AI.' });
    }

    // Shape and size first: everything below trusts these values.
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const q = normalizeQuestion(body.question);
    const h = normalizeHistory(body.history);
    const r = normalizeReport(body.report);
    const fileHash = typeof body.fileHash === 'string' && HASH_RE.test(body.fileHash) ? body.fileHash : undefined;
    const fileHandle = typeof body.fileHandle === 'string' && body.fileHandle.length <= 2048 ? body.fileHandle : undefined;
    if (!q.ok || !h.ok || !r.ok || (body.fileHash !== undefined && !fileHash)) {
      return res.status(400).json({ success: false, code: q.reason === 'too_long' ? 'QUESTION_TOO_LONG' : 'BAD_REQUEST', error: q.reason === 'too_long' ? `Keep the question under ${LIMITS.questionMax} characters.` : 'That question could not be read.' });
    }

    // Screening costs nothing: no quota, no model. Offenders collect strikes.
    const screen = screenQuestion(q.text, { hasHistory: h.turns.length > 0 });
    if (!screen.ok) {
      const state = strikes.add(keys, screen.strikes);
      log.warn('bsod_ai.screened', { kind: screen.kind, sessionId: String(req.sessionId).slice(0, 10), questionHash: safeToken(q.text) });
      if (state.locked) return lockedReply(res, state);
      return res.json({ success: true, refused: true, kind: screen.kind, answer: REPLIES[screen.kind], evidence: [] });
    }

    // One question at a time per session.
    if (inFlight.has(req.sessionId)) {
      return res.status(429).json({ success: false, code: 'BSOD_AI_BUSY', error: 'One question at a time, please.' });
    }
    inFlight.add(req.sessionId);

    const tier = wfSsoEnabled ? (req.tier || 'anon') : 'anon';
    const limits = tierLimits(tier);
    const windowSeconds = 60 * 60;
    const refundCap = Math.max(5, Math.floor(limits.requests / 2));
    let reservation;
    let globalReservation;
    let estimate = 0;
    // The refund cap stops failures from being farmed; when no provider ran at all
    // there is nothing to farm, so that refund is uncapped.
    // `tight`: an unusable model answer ran the provider, so it gets a smaller cap.
    const refund = async ({ uncapped = false, tight = false } = {}) => {
      for (const [held, cost, win] of [[reservation, estimate, windowSeconds], [globalReservation, 0, 24 * 60 * 60]]) {
        if (!held?.allowed) continue;
        const cap = uncapped || win > windowSeconds ? 1_000_000 : tight ? Math.max(2, Math.floor(limits.requests / 4)) : refundCap;
        try { await quotaLedger.refund(held, { requestCost: 1, tokenCost: cost, refundCap: cap, windowSeconds: win }); } catch (error) { log.warn('bsod_ai.refund_failed', { message: String(error?.message).slice(0, 120) }); }
      }
    };

    try {
      // Cheap precondition first: something to ask about (the owned dump, or a report).
      const owned = Boolean(fileHash) && sessionOwnsHash(req.sessionId, fileHash, fileHandle);
      if (!owned && !r.report) {
        return res.status(400).json({ success: false, code: 'NO_CASE', error: 'There is no crash report to ask about yet.' });
      }
      // The reservation comes before the evidence fetch (an upstream call): the
      // estimate is the largest the prompt can be, and settles to actual usage.
      const promptChars = Buffer.byteLength(SYSTEM_INSTRUCTION) + (owned ? LIMITS.caseEvidenceChars : 0) + LIMITS.reportChars
        + h.turns.reduce((n, turn) => n + turn.text.length, 0) + q.text.length + 600;
      estimate = Math.ceil(promptChars / 3) + LIMITS.maxOutputTokens;

      // A global daily ceiling, then the visitor's own hourly allowance (charged
      // to the session and, for anonymous visitors, the address as well).
      if (globalDailyLimit > 0) {
        globalReservation = await quotaLedger.reserve([{ key: 'ai-chat:global', requestLimit: globalDailyLimit, tokenLimit: globalDailyLimit * 20_000 }], { requestCost: 1, tokenCost: 0, windowSeconds: 24 * 60 * 60 });
        if (!globalReservation.allowed) {
          return res.status(503).json({ success: false, code: 'BSOD_AI_RESTING', error: 'BSOD AI is resting. Your question was not counted.' });
        }
      }
      // The session cannot be reset by a new Turnstile solve from the same address
      // (the address is charged too), but an address can be an office or a mobile
      // carrier, so its allowance is a multiple of one session's.
      const byAddress = !(wfSsoEnabled && req.wfUserId);
      const owner = byAddress ? `ai-chat:ip:${rateLimitKey(req)}` : `ai-chat:wfuser:${req.wfUserId}`;
      const factor = byAddress ? ADDRESS_ALLOWANCE : 1;
      reservation = await quotaLedger.reserve([
        { key: `ai-chat:sess:${req.sessionId}`, requestLimit: limits.requests, tokenLimit: limits.tokens },
        { key: owner, requestLimit: limits.requests * factor, tokenLimit: limits.tokens * factor },
      ], { requestCost: 1, tokenCost: estimate, windowSeconds });
      if (!reservation.allowed) {
        const resetTime = reservation.resetTime;
        await refund();
        return res.status(429).json({ success: false, code: 'BSOD_AI_QUOTA', error: `That was your ${limits.requests} questions for this hour.`, resetTime });
      }

      // The case file: the server's copy of the dump's evidence when this
      // session uploaded it, plus the report the visitor sees.
      let signalText = '';
      if (owned) {
        const evidence = await loadEvidence(req.sessionId, fileHash, fileHandle);
        signalText = evidence?.analysisSignalText || '';
      }
      const caseFile = buildCaseFile({ signalText, report: r.report, redact });
      if (!caseFile.text) {
        await refund({ uncapped: true });
        return res.status(400).json({ success: false, code: 'NO_CASE', error: 'There is no crash report to ask about yet.' });
      }
      const contents = buildChatContents({ caseFile, history: h.turns, question: q.text });

      const response = await generateChat({
        model: MODEL,
        contents,
        config: { systemInstruction: SYSTEM_INSTRUCTION, responseMimeType: 'application/json', maxOutputTokens: LIMITS.maxOutputTokens, temperature: 0.4 },
      }, { deadline: createDeadline() });

      const used = (response.usageMetadata?.promptTokenCount ?? 0) + (response.usageMetadata?.candidatesTokenCount ?? 0);
      if (used > 0) await quotaLedger.commit(reservation, { tokenDelta: used - estimate });

      const parsed = parseChatAnswer(response.text ?? '');
      if (!parsed.valid) {
        log.warn('bsod_ai.invalid_answer', { reason: parsed.reason, sessionId: String(req.sessionId).slice(0, 10) });
        // A reply that tries to leak the rules is an attack signal, not a glitch: it is charged and struck.
        if (parsed.reason === 'leak') strikes.add([keys[0]], 2);
        else await refund({ tight: true });
        return res.status(502).json({ success: false, code: 'BSOD_AI_FAILED', error: 'BSOD AI got confused. Your question was not counted. Try again.' });
      }
      if (!parsed.onTopic) {
        strikes.add([keys[0]], 1);
        return res.json({ success: true, refused: true, kind: 'off_topic', answer: REPLIES.off_topic, evidence: [], remaining: Math.max(0, limits.requests - reservation.requests) });
      }
      log.info('bsod_ai.answered', {
        sessionId: String(req.sessionId).slice(0, 10), tier, verified: caseFile.verified, unsafe: Boolean(parsed.unsafe),
        leg: response.cacheModel, inputTokens: response.usageMetadata?.promptTokenCount, outputTokens: response.usageMetadata?.candidatesTokenCount,
        questionHash: safeToken(q.text), ms: now() - started,
      });
      return res.json({ success: true, answer: parsed.answer, evidence: parsed.evidence, remaining: Math.max(0, limits.requests - reservation.requests), model: MODEL });
    } catch (error) {
      await refund({ uncapped: error?.code === 'BSOD_AI_NO_FREE_CAPACITY' });
      if (error?.code === 'BSOD_AI_NO_FREE_CAPACITY') {
        return res.status(503).json({ success: false, code: 'BSOD_AI_RESTING', error: 'BSOD AI is resting. It is out of free capacity right now. Your question was not counted.' });
      }
      log.warn('bsod_ai.error', { code: error?.code, status: error?.status, message: String(error?.message || '').slice(0, 140) });
      const timeout = error?.code === 'AI_TIMEOUT' || /timed out/i.test(error?.message || '');
      return res.status(timeout ? 504 : 502).json({ success: false, code: 'BSOD_AI_FAILED', error: 'BSOD AI could not answer. Your question was not counted. Try again.' });
    } finally {
      inFlight.delete(req.sessionId);
    }
  });
}
