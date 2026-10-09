// Related WindowsForum discussions for a finished analysis, found through the
// forum's public MCP server (https://mcp.windowsforum.com/, stateless, no auth)
// and its `search` tool (BM25 + semantic). Only the stop code, its name and the
// faulting module's file name are sent; never dump contents. Best-effort by
// design: results are cached per instance, a slow or failing forum yields
// { available: false } and never blocks or fails an analysis.
import { extractStatsFacts, normalizeLabel, normalizeModuleKey, normalizeStopCode } from './stats.js';
import { PSEUDO_MODULES } from './crashPriors.js';
import { BSOD_FORUM_URL, FORUM_ORIGIN, isForumUrl, withForumUtm } from '../shared/forumLinks.js';

export const DEFAULT_FORUM_MCP_URL = 'https://mcp.windowsforum.com/';
const MCP_PROTOCOL_VERSION = '2025-06-18';
const USER_AGENT = 'bsod-analyzer (+https://bsod.windowsforum.com)';

// Kernel images appear in most crashes, so as a search key they match nearly
// every BSOD thread and say nothing about this one.
const GENERIC_MODULES = new Set([
  ...PSEUDO_MODULES,
  'nt', 'ntoskrnl', 'ntoskrnl.exe', 'ntkrnlmp.exe', 'ntkrnlpa.exe', 'ntkrpamp.exe', 'hal', 'hal.dll'
]);
const SEARCH_MODULE_RE = /^[a-z0-9_.-]{2,64}$/;
const BSOD_BOARD_SEGMENT = '/windows-blue-screen-of-death-bsod.307/';
const MAX_TITLE_CHARS = 150;
const MAX_SNIPPET_CHARS = 180;

// ---------------------------------------------------------------------------
// MCP client (JSON-RPC over streamable HTTP; the server answers in SSE or JSON)
// ---------------------------------------------------------------------------

export function parseSseMessages(body) {
  const messages = [];
  for (const event of String(body || '').split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    try {
      messages.push(JSON.parse(data));
    } catch { /* skip a malformed event */ }
  }
  return messages;
}

function toolText(result) {
  const item = Array.isArray(result?.content) ? result.content.find(c => c?.type === 'text') : null;
  return typeof item?.text === 'string' ? item.text : '';
}

export function createForumMcpClient({
  url = DEFAULT_FORUM_MCP_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 3000,
  maxBodyChars = 1_000_000
} = {}) {
  let nextId = 0;

  async function callTool(name, args) {
    const id = ++nextId;
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
        'User-Agent': USER_AGENT
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      const error = new Error(`forum MCP HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const body = await response.text();
    if (body.length > maxBodyChars) throw new Error('forum MCP response too large');
    const type = String(response.headers?.get?.('content-type') || '');
    const messages = type.includes('text/event-stream') ? parseSseMessages(body) : [JSON.parse(body)].flat();
    const message = messages.find(m => m && m.id === id && ('result' in m || 'error' in m));
    if (!message) throw new Error('forum MCP returned no response for the request');
    if (message.error) throw new Error(`forum MCP error ${message.error.code}: ${message.error.message}`);
    const result = message.result || {};
    if (result.isError) throw new Error(`forum MCP tool error: ${toolText(result).slice(0, 200)}`);
    if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
    return JSON.parse(toolText(result));
  }

  return { callTool };
}

// ---------------------------------------------------------------------------
// Search keys and query
// ---------------------------------------------------------------------------

// { code, name, module } from the browser or a report -> validated keys, or
// null when neither a stop code nor a specific module survives. Idempotent.
export function normalizeRelatedKeys({ code, name, module } = {}) {
  let stop = normalizeStopCode(code);
  // Bug check codes are 32-bit and never zero; "0x0" would match the hex
  // arguments quoted in nearly every thread.
  if (stop && (stop.code === '0x0' || stop.code.length > 10)) stop = undefined;
  const label = normalizeLabel(name) || stop?.label;
  let image = normalizeModuleKey(module);
  if (image && (!SEARCH_MODULE_RE.test(image) || GENERIC_MODULES.has(image))) image = undefined;
  if (!stop && !image) return null;
  return { code: stop?.code || null, name: label || null, module: image || null };
}

export function relatedKeysForAnalysis({ structured, report } = {}) {
  const facts = extractStatsFacts({ source: 'windbg', structured, aiReport: report });
  if (!facts) return null;
  return normalizeRelatedKeys({ code: facts.stopCode, name: facts.stopCodeLabel, module: facts.module });
}

export function buildRelatedQuery(keys) {
  const parts = [keys.name, keys.code, keys.module].filter(Boolean);
  if (!keys.name) parts.push('BSOD');
  return parts.join(' ');
}

function cacheKey(keys) {
  return `${keys.code || ''}|${keys.name || ''}|${keys.module || ''}`.toLowerCase();
}

// ---------------------------------------------------------------------------
// Ranking: keep only results that actually mention this crash's keys
// ---------------------------------------------------------------------------

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

function matchers(keys) {
  const code = keys.code ? keys.code.slice(2) : '';
  const codeRes = [];
  if (code) codeRes.push(new RegExp(`\\b0x0*${code}\\b`, 'i'));
  // WinDbg's "NAME (133)" form; too ambiguous for one- or two-digit codes.
  if (code.length >= 3) codeRes.push(new RegExp(`\\(0*${code}\\)`, 'i'));
  if (keys.name) codeRes.push(new RegExp(`\\b${keys.name}\\b`, 'i'));

  let moduleRe = null;
  if (keys.module) {
    const stem = keys.module.replace(/\.(sys|dll|exe)$/, '');
    if (stem.length >= 4) moduleRe = new RegExp(`\\b${escapeRegExp(stem)}(?:\\.(?:sys|dll|exe))?\\b`, 'i');
    else if (stem !== keys.module) moduleRe = new RegExp(`\\b${escapeRegExp(keys.module)}\\b`, 'i');
  }
  return {
    code: text => codeRes.some(re => re.test(text)),
    module: text => Boolean(moduleRe && moduleRe.test(text))
  };
}

function threadIdOf(result) {
  const byId = String(result?.id || '').match(/^thread-(\d+)$/);
  if (byId) return Number(byId[1]);
  const meta = Number(result?.metadata?.thread_id);
  if (Number.isSafeInteger(meta) && meta > 0) return meta;
  try {
    const segments = new URL(String(result?.url || '')).pathname.split('/').filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i--) {
      const m = segments[i].match(/\.(\d+)$/);
      if (m) return Number(m[1]);
    }
  } catch { /* no usable URL */ }
  return null;
}

// Forum result fields are capped before cleaning: results are only checked for
// the crash's keys and shown truncated to MAX_TITLE_CHARS / MAX_SNIPPET_CHARS,
// and nothing else bounds a field below the 1M-char response limit. The tag
// pattern excludes '<' so a scan from one '<' stops at the next one; /<[^>]*>/
// rescanned to the end of the string from every unclosed '<', which is
// quadratic and blocked the event loop for seconds on one long '<' run
// (issue #152).
const MAX_FIELD_CHARS = 2000;

function cleanText(value) {
  return String(value || '')
    .slice(0, MAX_FIELD_CHARS)
    .replace(/<[^<>]*>/g, ' ')
    .replace(/\[\*\]/g, ' ')
    .replace(/\*{3,}|-{3,}|={3,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const KINDS = { threads: 'thread', news: 'news', tutorials: 'tutorial' };
const MATCH_RANK = { 'code+module': 3, module: 2, code: 1 };

function matchLabel(code, module) {
  if (code && module) return 'code+module';
  if (module) return 'module';
  return code ? 'code' : null;
}

// Search results -> [{ threadId, title, snippet, url, match, kind }], deduped
// by thread (post hits repeat their thread), off-topic hits dropped, strongest
// match first, then threads on the BSOD board, then the forum's own order.
export function rankRelatedResults(results, keys, limit = 5) {
  const test = matchers(keys);
  const byThread = new Map();

  (Array.isArray(results) ? results : []).forEach((result, index) => {
    if (!result || typeof result !== 'object') return;
    const threadId = threadIdOf(result);
    const title = cleanText(result.title);
    if (!threadId || !title) return;
    const url = isForumUrl(result.url) ? String(result.url) : `${FORUM_ORIGIN}/threads/${threadId}/`;
    const text = cleanText(result.text || result.snippet);
    const haystack = `${title} ${text}`;
    const code = test.code(haystack);
    const module = test.module(haystack);
    const isThread = String(result.id || '').startsWith('thread-');

    const existing = byThread.get(threadId);
    if (!existing) {
      byThread.set(threadId, {
        index, threadId, title, url, text, code, module, isThread,
        kind: KINDS[result.section] || 'thread'
      });
      return;
    }
    // A thread and its posts: union the evidence, prefer the thread's own
    // title/URL, and keep the snippet that shows the strongest match.
    const betterSnippet = (code || module) && !(existing.code || existing.module);
    existing.code = existing.code || code;
    existing.module = existing.module || module;
    if (isThread && !existing.isThread) {
      Object.assign(existing, { title, url, isThread });
    }
    if (betterSnippet) existing.text = text;
  });

  return [...byThread.values()]
    .map(entry => ({ ...entry, match: matchLabel(entry.code, entry.module) }))
    .filter(entry => entry.match)
    .sort((a, b) => (MATCH_RANK[b.match] - MATCH_RANK[a.match])
      || (Number(b.url.includes(BSOD_BOARD_SEGMENT)) - Number(a.url.includes(BSOD_BOARD_SEGMENT)))
      || (a.index - b.index))
    .slice(0, limit)
    .map(entry => ({
      threadId: entry.threadId,
      title: truncate(entry.title, MAX_TITLE_CHARS),
      snippet: truncate(entry.text, MAX_SNIPPET_CHARS),
      url: entry.url,
      match: entry.match,
      kind: entry.kind
    }));
}

// ---------------------------------------------------------------------------
// Cached, fail-open service
// ---------------------------------------------------------------------------

export function createForumRelatedService({
  isEnabled = () => true,
  client,
  now = () => Date.now(),
  ttlMs = 12 * 60 * 60 * 1000,
  emptyTtlMs = 30 * 60 * 1000,
  maxEntries = 2000,
  limit = 5,
  searchLimit = 10,
  breakerThreshold = 3,
  breakerCooldownMs = 60 * 1000,
  logger = console
} = {}) {
  const cache = new Map(); // key -> { threads, expiresAt }
  const inFlight = new Map(); // key -> Promise
  let failures = 0;
  let openUntil = 0;

  const unavailable = () => ({ available: false, threads: [] });

  function prune(at = now()) {
    // Expired entries linger one extra TTL so a failed refresh can serve them.
    for (const [key, entry] of cache) {
      if (entry.expiresAt + ttlMs <= at) cache.delete(key);
    }
  }

  function remember(key, threads) {
    cache.delete(key);
    cache.set(key, { threads, expiresAt: now() + (threads.length ? ttlMs : emptyTtlMs) });
    if (cache.size <= maxEntries) return;
    prune();
    for (const oldest of cache.keys()) {
      if (cache.size <= maxEntries) break;
      cache.delete(oldest);
    }
  }

  async function search(keys) {
    const data = await client.callTool('search', {
      query: buildRelatedQuery(keys),
      section: 'all',
      limit: searchLimit,
      source: 'auto'
    });
    if (!Array.isArray(data?.results)) throw new Error('forum search returned no results array');
    return rankRelatedResults(data.results, keys, limit);
  }

  async function find(rawKeys) {
    if (!isEnabled() || !client) return unavailable();
    const keys = normalizeRelatedKeys(rawKeys || {});
    if (!keys) return unavailable();
    const key = cacheKey(keys);
    const entry = cache.get(key);
    if (entry && entry.expiresAt > now()) return { available: true, threads: entry.threads, cached: true };
    if (now() < openUntil) return entry ? { available: true, threads: entry.threads, stale: true } : unavailable();

    let pending = inFlight.get(key);
    if (!pending) {
      pending = search(keys)
        .then(threads => {
          failures = 0;
          remember(key, threads);
          return { available: true, threads };
        }, error => {
          failures += 1;
          if (failures >= breakerThreshold) {
            openUntil = now() + breakerCooldownMs;
            failures = 0;
          }
          logger.warn?.('forum.related_failed', { error: error?.message || String(error) });
          const stale = cache.get(key);
          return stale ? { available: true, threads: stale.threads, stale: true } : unavailable();
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    return pending;
  }

  // Related threads for a completed WinDBG analysis (external API). Plain
  // forum URLs: the consumer is the forum itself, so no campaign tags.
  async function findForAnalysis({ structured, report } = {}) {
    const keys = relatedKeysForAnalysis({ structured, report });
    if (!keys) return [];
    const result = await find(keys);
    return result.threads;
  }

  return { find, findForAnalysis, prune };
}

function firstParam(value) {
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === 'string' ? text.slice(0, 128) : undefined;
}

export function registerForumRelatedRoute(app, { service, middlewares = [] }) {
  app.get('/api/forum/related', ...middlewares, async (req, res) => {
    const query = req.query || {};
    const keys = normalizeRelatedKeys({
      code: firstParam(query.code),
      name: firstParam(query.name),
      module: firstParam(query.module)
    });
    if (!keys) {
      return res.status(400).json({
        success: false,
        error: 'A stop code or a specific driver name is required',
        code: 'INVALID_QUERY'
      });
    }
    const result = await service.find(keys);
    res.set({ 'Cache-Control': result.available ? 'private, max-age=900' : 'no-store' });
    return res.json({
      success: true,
      available: result.available,
      query: keys,
      threads: result.threads.map(thread => ({ ...thread, url: withForumUtm(thread.url) })),
      boardUrl: BSOD_FORUM_URL
    });
  });
}
