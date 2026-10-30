// Conservative redaction of personal identifiers in dump text before it goes
// into an AI prompt (issue #345). Used on the browser's WinDBG-fallback path,
// where strings read straight from the dump are sent to the AI provider and
// stored with the report (bsod_corpus.ai_reports.prompt_text).
//
// Only identifiers with an unambiguous shape are touched:
//  - the profile folder name in "...\Users\<name>..." (also "Documents and
//    Settings", any drive or UNC prefix, forward slashes, any case): the whole
//    path segment when it is followed by a separator or ends a path standing
//    on its own (names contain spaces: issue #360), and a conservative name
//    when the path ends inside running text (issue #363, profileNameOf);
//  - the values of identifying environment strings (USERNAME=, COMPUTERNAME=,
//    USERDOMAIN=, LOGONSERVER=, CLIENTNAME=, and the last path segment of
//    USERPROFILE=, HOMEPATH=, HOMESHARE= when that path is profile-folder
//    shaped, not inside Windows: issue #362), keeping the key;
//  - every other whole-word occurrence of the best-ranked MAX_HUNTED_NAMES
//    user or computer names found by the two rules above (3+ characters, or
//    2+ for names beyond Latin-1 such as 田中, with a script-aware word
//    boundary), plus the ASCII fragments of names with non-ASCII characters
//    (the prompt's strings are cut there: issue #365). Callers collect the
//    names from the dump bytes (collectPersonalNamesFromBytes);
//  - email addresses.
// Computer names (DESKTOP-XXXX and the like) have no reliable pattern on their
// own and are only redacted when an environment string names them. Everything
// else, including driver and module paths (\SystemRoot\System32\drivers\foo.sys,
// C:\Program Files\...), stays byte-identical so the crash evidence is
// unchanged. Built-in account and profile names (SYSTEM, Administrator,
// Public, ...) and Windows directory names (System32, AppData, ...) identify
// nobody and are kept so the evidence stays readable (NON_PERSONAL_NAMES).
//
// Design rule: when unsure, leave crash evidence alone, and only treat a
// string as a name when it is structurally a profile or user identifier.
//
// findPersonalSpans() is the single rule set: the string redactor below and
// the byte redactor for hex-dumped excerpts (issue #359) both use it, so the
// two cannot drift. Every scan is linear: the patterns have no nested or
// overlapping quantifiers, email addresses are scanned from each '@'
// (findEmails), and name hunting walks a trie of at most MAX_HUNTED_NAMES
// names from each word start.

export const REDACTED_USER = '<user>';
export const REDACTED_HOST = '<host>';
export const REDACTED_EMAIL = '<email>';

// Characters Windows forbids in a path segment, plus control characters.
// '<' and '>' are excluded, so an already-redacted "<user>" never re-matches.
const SEGMENT_FORBIDDEN = '\\\\/:*?"<>|\\x00-\\x1f';

// "\Users\" or "/users/" (or Documents and Settings) after a separator, then
// the path segment that holds the profile name: every path-segment character
// up to the next forbidden character (separator, ':', '"', control character
// / end of line, ...) or end of text. profileNameOf() decides how much of
// that segment is the name.
const PROFILE_PATH = new RegExp(
  `([\\\\/](?:users|documents and settings)[\\\\/]+)([^${SEGMENT_FORBIDDEN}]+)`,
  'gi'
);

// Characters Windows does not allow in an account name, so a segment holding
// one is not a profile folder name as a whole.
const ACCOUNT_INVALID = /[,;=+[\]@]/;

// The conservative name in running text: the first word, plus up to two
// following capitalised (or uncased-script) words; never past whitespace
// before another kind of word, or past , ; : ) " & | < > (issue #363).
const FREE_TEXT_NAME = new RegExp(
  `[^\\s,;=+()\\[\\]"&|!${SEGMENT_FORBIDDEN}]+(?: [\\p{Lu}\\p{Lo}][\\p{L}\\p{M}'.-]*){0,2}`,
  'uy'
);

// How much of a profile-path segment (`seg`, starting at `start` in `text`)
// is the profile name (issue #363):
//  - followed by a separator: the whole segment, when it could be an account
//    name (no , ; = + [ ] @, no trailing space or dot);
//  - ending the path otherwise, on a path-shaped line (nothing but non-space
//    characters before the path: a bare path, KEY=C:\Users\..., "C:\Users\..."):
//    the whole segment minus trailing dots and spaces, so a KEY=value like
//    USERPROFILE=C:\Users\John Smith keeps its multi-word name (#360);
//  - in running text: FREE_TEXT_NAME, and multi-word names also hunt their
//    first word on its own.
// Returns { name, free } (`free`: decided by the running-text rule).
function profileNameOf(text, start, seg, pathShapedLine) {
  const followedBySeparator = text[start + seg.length] === '\\' || text[start + seg.length] === '/';
  if (!ACCOUNT_INVALID.test(seg)) {
    if (followedBySeparator && !/[ .]$/.test(seg)) return { name: seg, free: false };
    if (!followedBySeparator && pathShapedLine) return { name: seg.replace(/[ .]+$/, ''), free: false };
  }
  FREE_TEXT_NAME.lastIndex = start;
  const m = FREE_TEXT_NAME.exec(text);
  const name = m ? m[0].replace(/(?:'s|')$/i, '').replace(/[.]+$/, '') : '';
  return { name, free: true };
}

// KEY=value environment strings whose value identifies the user or machine.
// The value runs to the end of the line (or the NUL that ends it in a dump).
const ENV_VALUE = /(?<![A-Za-z0-9_])(USERNAME|USERPROFILE|HOMEPATH|HOMESHARE|USERDOMAIN_ROAMINGPROFILE|USERDOMAIN|USERDNSDOMAIN|COMPUTERNAME|LOGONSERVER|CLIENTNAME)=([^\x00-\x1f]+)/gi;
const ENV_PATH_KEYS = new Set(['userprofile', 'homepath', 'homeshare']);
const ENV_HOST_KEYS = new Set(['userdomain', 'userdomain_roamingprofile', 'userdnsdomain', 'computername', 'logonserver', 'clientname']);

// The allow-list: names that identify nobody, so they are never redacted or
// hunted. Built-in accounts and service identities, shared profile folders,
// workgroup/tenant names, and Windows directory and well-known folder names
// (a path segment like "System32" must never become a "user name": issue
// #362). Lowercase; compared after trimming.
export const NON_PERSONAL_NAMES = new Set([
  // Built-in and service accounts, shared profiles.
  'public', 'default', 'default user', 'all users', 'defaultapppool', 'defaultuser0', 'defaultaccount',
  'administrator', 'administrators', 'admin', 'guest', 'wdagutilityaccount', 'owner', 'user', 'users',
  'system', 'local system', 'localsystem', 'systemprofile', 'local service', 'localservice',
  'network service', 'networkservice', 'nt authority', 'nt service', 'trustedinstaller', 'iusr',
  'font driver host', 'window manager', 'everyone', 'authenticated users',
  // Domains and tenants.
  'workgroup', 'azuread', 'localhost', 'microsoft', 'microsoftaccount', 'builtin',
  // Windows directories and well-known folders.
  'windows', 'winnt', 'system32', 'syswow64', 'sysnative', 'systemroot', 'drivers', 'driverstore',
  'serviceprofiles', 'config', 'winsxs', 'temp', 'tmp', 'program files', 'program files (x86)',
  'programdata', 'appdata', 'local', 'locallow', 'roaming', 'local settings', 'application data',
  'documents and settings', 'desktop', 'documents', 'my documents', 'downloads', 'onedrive',
]);
const NON_PERSONAL = NON_PERSONAL_NAMES;

// Directories that put a path inside Windows itself: a path-valued
// environment string under one of them (HOMEPATH=\Windows\system32 for
// LocalSystem, USERPROFILE=C:\Windows\ServiceProfiles\LocalService) names
// no user (issue #362).
const SYSTEM_DIRECTORIES = new Set(['windows', 'winnt', 'system32', 'syswow64', 'sysnative', 'systemroot', 'serviceprofiles', 'config', 'program files', 'program files (x86)', 'programdata']);

// The user-name segment of a USERPROFILE=/HOMEPATH=/HOMESHARE= value: its last
// segment, when the path is profile-folder shaped (no Windows system directory
// on the way); otherwise null. Values under \Users\ are also covered by
// PROFILE_PATH.
function profileSegmentOf(value) {
  const segments = value.split(/[\\/]/);
  const last = segments[segments.length - 1];
  for (let i = 0; i < segments.length - 1; i++) {
    if (SYSTEM_DIRECTORIES.has(segments[i].trim().toLowerCase())) return null;
  }
  return last;
}

// Email addresses: local@domain.tld with a local part of at most 64 of
// [A-Za-z0-9._%+-], up to ten domain labels of at most 63 of [A-Za-z0-9-],
// and an alphabetic TLD of 2-24 letters followed by a non-word character (so
// "foo.sys@1.2.3" and "@%SystemRoot%" do not match). Scanned from each '@'
// instead of with a regex: a regex retries its 64-char local-part window at
// every position, about 64 steps per byte on long letter runs (issue #367).
// The local part and the domain stop at the neighbouring '@', so the scan
// reads each character a bounded number of times.
const MAX_EMAIL_LOCAL = 64;
const MAX_EMAIL_LABEL = 63;
const MAX_EMAIL_LABELS = 10;
const isAlnumCode = c => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isAlphaCode = c => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
// . _ % + -
const isEmailLocalCode = c => isAlnumCode(c) || c === 0x2e || c === 0x5f || c === 0x25 || c === 0x2b || c === 0x2d;
const isLabelCode = c => isAlnumCode(c) || c === 0x2d;

function findEmails(text, spans) {
  let lastEnd = 0;
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    let start = at;
    while (start > lastEnd && at - start < MAX_EMAIL_LOCAL && isEmailLocalCode(text.charCodeAt(start - 1))) start--;
    if (start === at) continue;
    // Domain labels after the '@', each [start, end).
    const labels = [];
    let p = at + 1;
    while (labels.length < 2 * MAX_EMAIL_LABELS) {
      let q = p;
      while (q < text.length && q - p <= MAX_EMAIL_LABEL && isLabelCode(text.charCodeAt(q))) q++;
      if (q === p || q - p > MAX_EMAIL_LABEL) break;
      labels.push(p, q);
      if (text.charCodeAt(q) !== 0x2e) break;
      p = q + 1;
    }
    // The last label that can end the address: alphabetic, 2-24 letters, not
    // followed by a word character; at least one label before it.
    let end = -1;
    for (let k = labels.length - 2; k >= 2 && end < 0; k -= 2) {
      const from = labels[k];
      const to = labels[k + 1];
      if (to - from < 2 || to - from > 24) continue;
      let alpha = true;
      for (let i = from; i < to && alpha; i++) alpha = isAlphaCode(text.charCodeAt(i));
      const next = text.charCodeAt(to);
      if (alpha && !(isAlnumCode(next) || next === 0x5f)) end = to;
    }
    if (end < 0) continue;
    spans.push({ start, end, token: REDACTED_EMAIL });
    lastEnd = end;
    at = end - 1;
  }
}

const MIN_HUNTED_NAME = 3;
const MAX_HUNTED_NAME = 64;
// Names hunted in one text, best ranked first (issue #364), and the most
// distinct candidates remembered while collecting (beyond it only the counts
// of known candidates still grow), so both time and memory stay bounded.
export const MAX_HUNTED_NAMES = 128;
const MAX_NAME_CANDIDATES = 4096;

// Candidate ranks: a name seen as a profile folder or a user environment value
// outranks a computer/domain name, which outranks a derived name (the first
// word of a running-text name).
const RANK_USER = 0;
const RANK_HOST = 1;
const RANK_DERIVED = 2;

const isPersonal = name => {
  const key = name.trim().toLowerCase();
  return key.length > 0 && !key.startsWith('<') && !NON_PERSONAL.has(key);
};

/**
 * Names found in dump text, keyed by the lowercased name. A value is the
 * candidate's replacement token, rank, occurrence count and first-seen order
 * (or just a token). Entries are replaced, never mutated, so a copied map can
 * be extended safely.
 * @typedef {{ token: string, rank: number, count: number, order: number }} NameCandidate
 * @typedef {Map<string, NameCandidate | string>} PersonalNames
 */
// Names with a character beyond Latin-1 (Chinese, Japanese, Korean, ...) are
// hunted from two characters: such names are often two characters long, and
// the script-aware boundary keeps them from matching inside longer words.
const BEYOND_LATIN1 = /[^\x00-\xff]/;
// ASCII runs of a name, for names with non-ASCII characters: the prompt's
// strings are cut at the first non-ASCII character, so "Zoë Thompson" shows
// up there as " Thompson..." and "Jürgen" as "rgen..." (issue #365).
const ASCII_FRAGMENT = /[\x20-\x7e]+/g;

function addName(names, name, token, rank) {
  const trimmed = name.trim();
  if (trimmed.length > MAX_HUNTED_NAME) return;
  if (/[^\x00-\x7f]/.test(trimmed)) {
    for (const [fragment] of trimmed.matchAll(ASCII_FRAGMENT)) {
      if (fragment.length < trimmed.length) addCandidate(names, fragment, token, RANK_DERIVED);
    }
  }
  addCandidate(names, trimmed, token, rank);
}

function addCandidate(names, name, token, rank) {
  const trimmed = name.trim();
  const key = trimmed.toLowerCase();
  if (trimmed.length < (BEYOND_LATIN1.test(trimmed) ? 2 : MIN_HUNTED_NAME) || !isPersonal(key)) return;
  const known = names.has(key) ? asCandidate(names.get(key), 0) : null;
  if (known) {
    names.set(key, { ...known, rank: Math.min(known.rank, rank), count: known.count + 1 });
  } else if (names.size < MAX_NAME_CANDIDATES) {
    names.set(key, { token, rank, count: 1, order: names.size });
  }
}

// Map values may also be plain tokens (callers building their own map).
const asCandidate = (value, order) => (typeof value === 'string'
  ? { token: value, rank: RANK_USER, count: 1, order }
  : value);

// "X:" ending at `index`, not preceded by another letter or digit.
function driveBefore(text, index) {
  if (index < 2 || text[index - 1] !== ':' || !/[A-Za-z]/.test(text[index - 2])) return false;
  return index < 3 || !/[A-Za-z0-9]/.test(text[index - 3]);
}

// Profile-name and environment-value spans in `text`, plus the names they
// reveal (see addName) when `names` is given.
function structuralSpans(text, names) {
  const spans = [];
  // Whether the current line (control characters end lines) has whitespace
  // before the match: tracked incrementally so the scan stays linear.
  let scanned = 0;
  let lineHasSpace = false;
  for (const m of text.matchAll(PROFILE_PATH)) {
    for (; scanned < m.index; scanned++) {
      const c = text.charCodeAt(scanned);
      if (c < 0x20) lineHasSpace = false;
      else if (c === 0x20 || c === 0xa0 || c === 0x3000) lineHasSpace = true;
    }
    // "/users/" counts only right after a drive letter (D:/users/x,
    // file:///C:/Users/x): elsewhere it is a URL path, not a profile folder.
    if (m[1][0] === '/' && !driveBefore(text, m.index)) continue;
    const start = m.index + m[1].length;
    const { name, free } = profileNameOf(text, start, m[2], !lineHasSpace);
    if (!isPersonal(name)) continue;
    spans.push({ start, end: start + name.length, token: REDACTED_USER });
    if (names) {
      addName(names, name, REDACTED_USER, RANK_USER);
      const space = name.indexOf(' ');
      if (free && space > 0) addName(names, name.slice(0, space), REDACTED_USER, RANK_DERIVED);
    }
  }
  for (const m of text.matchAll(ENV_VALUE)) {
    const key = m[1].toLowerCase();
    let value = m[2];
    let start = m.index + m[1].length + 1;
    if (ENV_PATH_KEYS.has(key)) {
      const segment = profileSegmentOf(value);
      if (segment === null) continue;
      start += value.length - segment.length;
      value = segment;
    } else if (key === 'logonserver') {
      const lead = value.length - value.replace(/^[\\/]+/, '').length;
      start += lead;
      value = value.slice(lead);
    }
    if (!isPersonal(value)) continue;
    const token = ENV_HOST_KEYS.has(key) ? REDACTED_HOST : REDACTED_USER;
    spans.push({ start, end: start + value.length, token });
    if (names) addName(names, value, token, token === REDACTED_HOST ? RANK_HOST : RANK_USER);
  }
  return spans;
}

/**
 * The user and computer names that dump text reveals (profile folder names,
 * USERNAME=/COMPUTERNAME=/... values), for hunting their other occurrences.
 * @param {string} text
 * @param {PersonalNames} [names] accumulator
 * @returns {PersonalNames}
 */
export function collectPersonalNames(text, names = new Map()) {
  if (typeof text === 'string' && text.length > 0) structuralSpans(text, names);
  return names;
}

// The MAX_HUNTED_NAMES best candidates: rank, then occurrence count, then
// first seen (issue #364).
function selectHuntedNames(names) {
  let order = 0;
  const candidates = [];
  for (const [key, value] of names) candidates.push([key, asCandidate(value, order++)]);
  candidates.sort(([, a], [, b]) => a.rank - b.rank || b.count - a.count || a.order - b.order);
  return candidates.slice(0, MAX_HUNTED_NAMES).map(([key, { token }]) => [key, token]);
}

// Word classes for the whole-word test: a hunted name must not touch another
// character of its own class. ASCII letters, digits and '_' and every Latin
// letter are one class (as \b would treat them, plus accented letters); other
// letters are classed by script, so 田中 matches in "田中さん" (Han next to
// Hiragana) but not inside "山田中学" (issue #365). Anything else is no class.
const SCRIPT_CLASSES = [
  ['latin', /[\p{Script=Latin}\p{N}_]/u],
  ['han', /\p{Script=Han}/u],
  ['hiragana', /\p{Script=Hiragana}/u],
  ['katakana', /\p{Script=Katakana}/u],
  ['hangul', /\p{Script=Hangul}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['greek', /\p{Script=Greek}/u],
  ['other', /[\p{L}\p{M}]/u],
];
// Class index + 1 per UTF-16 code unit (0: not computed yet), filled lazily.
const classCache = new Uint8Array(0x10000);
function wordClass(c) {
  if (c < 0x80) return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f ? 'latin' : null;
  let cached = classCache[c];
  if (cached === 0) {
    const ch = String.fromCharCode(c);
    const index = SCRIPT_CLASSES.findIndex(([, pattern]) => pattern.test(ch));
    cached = classCache[c] = index < 0 ? SCRIPT_CLASSES.length + 1 : index + 1;
  }
  return cached > SCRIPT_CLASSES.length ? null : SCRIPT_CLASSES[cached - 1][0];
}
// Whether positions `a` and `b` (b = a + 1) are in one word.
const joined = (text, a, b) => {
  if (a < 0 || b >= text.length) return false;
  const cls = wordClass(text.charCodeAt(a));
  return cls !== null && cls === wordClass(text.charCodeAt(b));
};

// Lowercase of one UTF-16 code unit (itself when lowercasing changes length).
function lowerCode(c) {
  if (c < 0x80) return c >= 0x41 && c <= 0x5a ? c + 0x20 : c;
  const lower = String.fromCharCode(c).toLowerCase();
  return lower.length === 1 ? lower.charCodeAt(0) : c;
}

// Every whole-word, case-insensitive occurrence of `entries` ([name, token])
// in `text`, pushed onto `spans`: the longest name wins at a position ("John
// Smith" over "John"), and matches do not overlap. A trie of the names is
// walked from each word start, at most MAX_HUNTED_NAME steps, so the scan is
// linear in the text whatever the names are.
function huntNames(text, entries, spans) {
  const root = new Map();
  for (const [key, token] of entries) {
    let node = root;
    for (let i = 0; i < key.length; i++) {
      const c = key.charCodeAt(i);
      let next = node.get(c);
      if (!next) node.set(c, (next = new Map()));
      node = next;
    }
    node.token = token;
  }
  for (let i = 0; i < text.length;) {
    let node = root.get(lowerCode(text.charCodeAt(i)));
    if (!node || joined(text, i - 1, i)) { i++; continue; }
    let end = -1;
    let token;
    for (let j = i; node && j - i < MAX_HUNTED_NAME;) {
      if (node.token !== undefined && !joined(text, j, j + 1)) {
        end = j + 1;
        token = node.token;
      }
      j++;
      node = j < text.length ? node.get(lowerCode(text.charCodeAt(j))) : undefined;
    }
    if (end < 0) { i++; continue; }
    spans.push({ start: i, end, token });
    i = end;
  }
}

/**
 * Every span of `text` to redact, sorted and merged: profile folder names,
 * identifying environment values, whole-word occurrences of `names` (plus the
 * names found in `text` itself) and email addresses.
 * @param {string} text
 * @param {PersonalNames} [names] extra names (collectPersonalNames)
 * @returns {Array<{start: number, end: number, token: string}>}
 */
export function findPersonalSpans(text, names) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const hunted = new Map(names ?? []);
  const spans = structuralSpans(text, hunted);
  if (hunted.size > 0) huntNames(text, selectHuntedNames(hunted), spans);
  findEmails(text, spans);
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start < last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

// Byte excerpts (the hex dumps in fallback prompts) are redacted as bytes,
// before they are formatted: in a hex dump a UTF-16 path reads
// "C.:.\.U.s.e.r.s." and an ASCII one is split across 16-byte lines, so no
// text rule can match it there (issue #359).
const BYTE_FILL = 0x2a; // '*', or '*' 0x00 in UTF-16LE
const MAX_PATH = 260;
const CHUNK = 0x2000;

function decodeUnits(units) {
  let out = '';
  for (let i = 0; i < units.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, units.subarray(i, i + CHUNK));
  }
  return out;
}

// One char per byte (Latin-1), or one per UTF-16LE code unit starting at
// `offset` (0 or 1: UTF-16 text in memory need not be 2-byte aligned).
function byteView(bytes, width, offset) {
  if (width === 1) return decodeUnits(bytes);
  const count = (bytes.length - offset) >> 1;
  const units = new Uint16Array(count);
  for (let i = 0, b = offset; i < count; i++, b += 2) units[i] = bytes[b] | (bytes[b + 1] << 8);
  return decodeUnits(units);
}

// Leading run of text-like units: printable ASCII as bytes; printable ASCII
// or Latin letters (U+00A0-U+017F) as UTF-16, where random binary rarely
// matches. Used for the start of a memory excerpt, where a string can begin
// before the excerpt and so lose the "\Users\" that would identify its name.
function leadingTextRun(text, width) {
  let n = 0;
  while (n < text.length && n < MAX_PATH) {
    const c = text.charCodeAt(n);
    const printable = (c >= 0x20 && c < 0x7f) || (width === 2 && c >= 0xa0 && c <= 0x17f);
    if (!printable) break;
    n++;
  }
  return n >= MIN_HUNTED_NAME ? n : 0;
}

// The bytes read as Latin-1 and as UTF-16LE at both alignments.
function textViews(bytes) {
  return [
    { text: byteView(bytes, 1, 0), width: 1, offset: 0 },
    { text: byteView(bytes, 2, 0), width: 2, offset: 0 },
    { text: byteView(bytes, 2, 1), width: 2, offset: 1 },
  ];
}

/**
 * The user and computer names a dump reveals, read from its bytes (Latin-1
 * and UTF-16LE at both alignments, the byte redactor's views). This is the
 * source of the names handed to both redactors: the prompt's extracted
 * strings are cut at the first non-ASCII character and drop non-ASCII text,
 * so names collected from them would miss "Zoë Thompson" or "田中" (issue
 * #365). Names with non-ASCII characters also yield their ASCII fragments.
 * @param {Uint8Array} bytes
 * @param {PersonalNames} [names] accumulator
 * @returns {PersonalNames}
 */
export function collectPersonalNamesFromBytes(bytes, names = new Map()) {
  if (!bytes || bytes.length === 0) return names;
  for (const view of textViews(bytes)) collectPersonalNames(view.text, names);
  return names;
}

/**
 * A copy of `bytes` with every personal identifier the text rules find
 * (profile folder names, identifying environment values, hunted names,
 * email addresses) overwritten in place, read as Latin-1 and as UTF-16LE at
 * both alignments. Masked characters become '*' (0x2A, or 2A 00 in UTF-16),
 * so the length and every offset stay the same. The input is not modified:
 * use the copy only for display (hex dumps), never for parsing or hashing.
 * @param {Uint8Array} bytes
 * @param {{ names?: PersonalNames, maskLeadingRun?: boolean }} [options]
 *   names: names found elsewhere in the dump (collectPersonalNames);
 *   maskLeadingRun: the excerpt starts mid-memory, so mask a text run at its
 *   very start (up to MAX_PATH chars) whose beginning may have been cut off.
 * @returns {Uint8Array}
 */
export function redactPersonalBytes(bytes, options = {}) {
  const out = bytes.slice();
  if (bytes.length === 0) return out;
  const views = textViews(bytes);
  const names = new Map(options.names ?? []);
  for (const view of views) collectPersonalNames(view.text, names);
  const mask = (view, start, end) => {
    for (let i = start; i < end; i++) {
      const at = view.offset + i * view.width;
      out[at] = BYTE_FILL;
      if (view.width === 2) out[at + 1] = 0;
    }
  };
  for (const view of views) {
    for (const { start, end } of findPersonalSpans(view.text, names)) mask(view, start, end);
    if (options.maskLeadingRun) mask(view, 0, leadingTextRun(view.text, view.width));
  }
  return out;
}

/**
 * Redact profile folder names, identifying environment values, the user and
 * computer names they reveal, and email addresses from dump-derived text.
 * NUL characters (left between the code units of UTF-16LE text decoded as
 * bytes) are dropped first so "U\0s\0e\0r\0s\0" cannot hide a path; prompts
 * never need them.
 * @param {string} text
 * @param {{ names?: PersonalNames }} [options] names found elsewhere in the dump
 * @returns {string}
 */
export function redactPersonalIdentifiers(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) return '';
  const clean = text.includes('\u0000') ? text.replace(/\u0000/g, '') : text;
  const spans = findPersonalSpans(clean, options.names);
  if (spans.length === 0) return clean;
  let out = '';
  let at = 0;
  for (const { start, end, token } of spans) {
    out += clean.slice(at, start) + token;
    at = end;
  }
  return out + clean.slice(at);
}
