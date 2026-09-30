// Corpus priors for the AI prompt: population statistics per stop code and per
// faulting module from bigquery/crash_insights.sql (published daily to Cloud
// Storage, read through server/gcsJson.js). Best-effort by design: a missing,
// slow or malformed priors file yields '' and never blocks or fails an analysis.
import { normalizeStopCode } from './stats.js';
import { WINDBG_OUTPUT_MARKER } from '../shared/promptTemplates.js';

export const PSEUDO_MODULES = new Set(['unknown_image', 'unknown', 'memory_corruption', 'ntoskrnl.wrong.symbols.exe']);
const MAX_CONTEXT_CHARS = 1200;

function pct(share) {
  const value = Number(share);
  if (!Number.isFinite(value)) return null;
  if (value > 0 && value < 0.01) return '<1%';
  return `${Math.round(value * 100)}%`;
}

function listOf(items, key, limit) {
  return (Array.isArray(items) ? items : [])
    .filter(item => item && item[key] && !PSEUDO_MODULES.has(String(item[key]).toLowerCase()))
    .slice(0, limit)
    .map(item => `${item[key]} (${pct(item.share)})`)
    .join(', ');
}

export function normalizePriorCode(value) {
  return normalizeStopCode(value)?.code || null;
}

export function normalizePriorImage(value) {
  const image = String(value || '').trim().toLowerCase();
  return image && !PSEUDO_MODULES.has(image) ? image : null;
}

function bugcheckLine(code, p) {
  const parts = [`${pct(p.share_of_all)} of analyses`];
  const modules = listOf(p.top_modules, 'image', 3);
  if (modules) parts.push(`faulting module most often ${modules}`);
  if (p.hardware_share != null) parts.push(`judged hardware-caused ${pct(p.hardware_share)}`);
  if (p.first_minute_share) parts.push(`${pct(p.first_minute_share)} within the first minute after boot`);
  return `- Stop code ${code}${p.name ? ` ${p.name}` : ''}: ${parts.join('; ')}.`;
}

function imageLine(image, p) {
  const parts = [`${Number(p.n).toLocaleString('en-US')} analyses`];
  const codes = listOf(p.top_stop_codes, 'code', 3);
  if (codes) parts.push(`usually ${codes}`);
  const versions = listOf(p.top_versions, 'version', 2);
  if (versions) parts.push(`most seen versions ${versions}`);
  if (p.hardware_share) parts.push(`judged hardware-caused ${pct(p.hardware_share)}`);
  return `- ${image}${p.manufacturer ? ` (${p.manufacturer})` : ''}: ${parts.join('; ')}.`;
}

export function formatPriorContext({ code, codePrior, image, imagePrior }) {
  const lines = [];
  if (codePrior) lines.push(bugcheckLine(code, codePrior));
  if (imagePrior) lines.push(imageLine(image, imagePrior));
  if (!lines.length) return '';
  const size = Number(codePrior?.corpus_size || imagePrior?.corpus_size) || 0;
  const header = `**Corpus context (statistics from ${size ? size.toLocaleString('en-US') + ' ' : ''}prior WinDBG analyses — priors, not evidence about this dump):**`;
  let text = [header, ...lines].join('\n');
  if (text.length > MAX_CONTEXT_CHARS) text = `${text.slice(0, MAX_CONTEXT_CHARS - 1)}…`;
  return text;
}

// Stop code and faulting image from the evidence tail of a WinDBG prompt: the
// structured JSON block (windbg_crash_signal_v1) when present, else raw
// !analyze fields.
export function extractPromptSignal(promptText) {
  const text = String(promptText || '');
  const at = text.lastIndexOf(WINDBG_OUTPUT_MARKER);
  const tail = at >= 0 ? text.slice(at) : text;
  let code = null;
  let image = null;

  // Use delimiter searches rather than a regex whose whitespace and content
  // repetitions can overlap and backtrack quadratically on a missing fence.
  const fenceStart = tail.indexOf('```json');
  const jsonStart = fenceStart < 0 ? -1 : fenceStart + '```json'.length;
  const fenceEnd = jsonStart < 0 ? -1 : tail.indexOf('```', jsonStart);
  if (fenceEnd >= 0) {
    try {
      const signal = JSON.parse(tail.slice(jsonStart, fenceEnd));
      code = signal?.bugcheck?.code ?? null;
      image = signal?.crash?.imageName ?? signal?.crash?.moduleName ?? null;
    } catch { /* fall through to regexes */ }
  }
  if (!code) {
    const m = tail.match(/"bugcheck"\s*:\s*\{[^{}]*?"code"\s*:\s*"(0x[0-9a-fA-F]+)"/)
      || tail.match(/BUGCHECK_CODE:\s*(?:0x)?([0-9a-fA-F]+)\b/);
    if (m) code = m[1].toLowerCase().startsWith('0x') ? m[1] : `0x${m[1]}`;
  }
  if (!image) {
    const m = tail.match(/"imageName"\s*:\s*"([^"]+)"/) || tail.match(/IMAGE_NAME:\s*(\S+)/);
    if (m) image = m[1];
  }
  return { bugcheckCode: code, imageName: image };
}

export function createCrashPriors({ reader, path = 'priors/000000000000.json', timeoutMs = 2000, logger = console } = {}) {
  let indexed = { rows: null, byKind: null };

  async function load() {
    const rows = await reader.read(path);
    if (rows !== indexed.rows) {
      const byKind = { bugcheck: new Map(), image: new Map() };
      for (const row of rows || []) {
        if (!row || !byKind[row.kind]) continue;
        // Canonicalize both kinds at index time: lookups go through
        // normalizePriorCode/normalizePriorImage, so a padded or lowercase
        // bugcheck key from the corpus would otherwise be stored under a form
        // no lookup can ever produce (issue #116).
        const key = row.kind === 'image' ? normalizePriorImage(row.key) : normalizePriorCode(row.key);
        if (!key) continue;
        try {
          byKind[row.kind].set(key, JSON.parse(row.payload));
        } catch { /* skip malformed row */ }
      }
      indexed = { rows, byKind };
    }
    return indexed.byKind;
  }

  async function contextFor({ bugcheckCode, imageName } = {}) {
    const code = normalizePriorCode(bugcheckCode);
    const image = normalizePriorImage(imageName);
    if (!code && !image) return '';
    let timer;
    try {
      const byKind = await Promise.race([
        load(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('priors timeout')), timeoutMs); })
      ]);
      return formatPriorContext({
        code,
        codePrior: code ? byKind.bugcheck.get(code) : null,
        image,
        imagePrior: image ? byKind.image.get(image) : null
      });
    } catch (error) {
      logger.warn?.('[priors] unavailable:', error?.message || error);
      return '';
    } finally {
      clearTimeout(timer);
    }
  }

  return { contextFor };
}
