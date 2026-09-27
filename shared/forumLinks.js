// WindowsForum links used by the analyzer (client) and the server. The BSOD
// board is the one place the analyzer sends people for community help, so
// every page links the same node.
export const FORUM_ORIGIN = 'https://windowsforum.com';
export const BSOD_FORUM_URL = `${FORUM_ORIGIN}/forums/windows-blue-screen-of-death-bsod.307/`;
export const FORUM_HOSTS = new Set(['windowsforum.com', 'www.windowsforum.com']);

const UTM = {
  utm_source: 'bsod.windowsforum.com',
  utm_medium: 'analyzer'
};

export function isForumUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && FORUM_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

// Campaign-tagged forum link so forum analytics can attribute analyzer traffic.
// Non-forum URLs are returned unchanged (never tagged, never rewritten).
export function withForumUtm(value, campaign = 'related_threads') {
  if (!isForumUrl(value)) return value;
  const url = new URL(value);
  for (const [key, val] of Object.entries(UTM)) url.searchParams.set(key, val);
  url.searchParams.set('utm_campaign', campaign);
  return url.toString();
}

// New-thread form on the BSOD board. XenForo ignores `title` if it does not
// prefill from the query string; the copied report is the reliable handoff.
export function bsodPostThreadUrl(title) {
  const url = new URL('post-thread', BSOD_FORUM_URL);
  const text = String(title || '').trim();
  if (text) url.searchParams.set('title', text);
  for (const [key, val] of Object.entries(UTM)) url.searchParams.set(key, val);
  url.searchParams.set('utm_campaign', 'ask_community');
  return url.toString();
}

// Search keys the analyzer sends to /api/forum/related. Only low-cardinality
// identifiers leave the browser (never dump text); the server re-validates them.
export function relatedKeysFromReport(report) {
  if (!report || typeof report !== 'object') return null;
  const code = report.bugCheck?.code || report.bugCheckCode || '';
  const name = report.bugCheck?.name || '';
  const culprit = String(report.culprit || '').trim();
  const module = report.imageName
    || report.crashLocation?.module
    || (/^[A-Za-z0-9_.-]{1,64}\.(sys|dll|exe)$/i.test(culprit) ? culprit : '');
  const keys = {
    code: String(code || '').trim(),
    name: String(name || '').trim(),
    module: String(module || '').trim()
  };
  return keys.code || keys.module ? keys : null;
}

const CODE_RE = /^0x[0-9a-f]{1,16}$/i;
const NAME_RE = /^[A-Z0-9_]{1,64}$/;
const MODULE_RE = /^[a-z0-9_.-]{1,64}$/i;

// "BSOD DPC_WATCHDOG_VIOLATION (0x133) – nvlddmkm.sys". Values originate in
// dump text, so only identifier-shaped tokens are used.
export function forumThreadTitle(keys = {}) {
  const rawCode = String(keys.code || '').trim();
  const code = CODE_RE.test(rawCode)
    ? `0x${rawCode.slice(2).replace(/^0+(?=.)/, '').toUpperCase()}`
    : '';
  const name = NAME_RE.test(String(keys.name || '').trim()) ? String(keys.name).trim() : '';
  const module = MODULE_RE.test(String(keys.module || '').trim()) ? String(keys.module).trim() : '';

  let stop = '';
  if (name && code) stop = `${name} (${code})`;
  else stop = name || code;

  const parts = ['BSOD'];
  if (stop) parts.push(stop);
  let title = parts.join(' ');
  if (module) title += `${stop ? ' –' : ''} ${module}`;
  if (title === 'BSOD') title = 'BSOD crash analysis – help needed';
  return title.slice(0, 100);
}
