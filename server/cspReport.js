// Collector for Content-Security-Policy violation reports (issue #154).
//
// The hash-based policy has shipped as Content-Security-Policy-Report-Only since
// #74, but with no report-uri/report-to its violations only ever reached each
// visitor's console, so there was no data to decide when CSP_MODE=enforce is
// safe. The strict policy now names CSP_REPORT_PATH in report-uri, and browsers
// POST `application/csp-report` here (`application/reports+json`, the Reporting
// API format, is accepted too in case report-to is added). Each distinct
// violation is logged once per window
// as a structured `csp.violation` event; repeats inside the window are only
// counted and reported with the next occurrence after it. URLs are cut to
// origin + path, every field is capped, and nothing is stored.
import { CSP_REPORT_PATH } from './securityHeaders.js';

export const CSP_REPORT_CONTENT_TYPES = ['application/csp-report', 'application/reports+json'];
export const CSP_REPORT_MAX_BYTES = 64 * 1024;
const MAX_REPORTS_PER_REQUEST = 20;

// blocked-uri keywords browsers use instead of a URL.
const BLOCKED_KEYWORDS = new Set(['inline', 'eval', 'wasm-eval', 'data', 'blob', 'self', 'trusted-types-policy', 'trusted-types-sink']);

function cap(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

// Origin + path only: queries and fragments can carry tokens or user input.
function cleanUrl(value) {
  const text = cap(value, 2048).trim();
  if (!text) return '';
  if (BLOCKED_KEYWORDS.has(text.toLowerCase())) return text.toLowerCase();
  try {
    const url = new URL(text);
    if (url.protocol === 'data:' || url.protocol === 'blob:') return url.protocol.slice(0, -1);
    return `${url.origin}${url.pathname}`.slice(0, 300);
  } catch {
    return text.split(/[?#]/)[0].slice(0, 300);
  }
}

function toInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// One report in either wire format -> the fields we log, or null.
function normalizeOne(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // report-uri: { "csp-report": { "document-uri": … } }
  const legacy = raw['csp-report'];
  if (legacy && typeof legacy === 'object') {
    return {
      document: cleanUrl(legacy['document-uri']),
      blocked: cleanUrl(legacy['blocked-uri']),
      directive: cap(legacy['effective-directive'] || legacy['violated-directive'], 80).split(' ')[0],
      source: cleanUrl(legacy['source-file']),
      line: toInt(legacy['line-number']),
      column: toInt(legacy['column-number']),
      sample: cap(legacy['script-sample'], 80),
      disposition: cap(legacy.disposition, 16) || 'unknown',
    };
  }
  // Reporting API: { type: "csp-violation", body: { documentURL: … } }
  if (raw.type === 'csp-violation' && raw.body && typeof raw.body === 'object') {
    const body = raw.body;
    return {
      document: cleanUrl(body.documentURL),
      blocked: cleanUrl(body.blockedURL),
      directive: cap(body.effectiveDirective, 80).split(' ')[0],
      source: cleanUrl(body.sourceFile),
      line: toInt(body.lineNumber),
      column: toInt(body.columnNumber),
      sample: cap(body.sample, 80),
      disposition: cap(body.disposition, 16) || 'unknown',
    };
  }
  return null;
}

// Request body (string, as the content-type parser hands it over) -> reports.
export function parseCspReports(body) {
  let parsed;
  try {
    parsed = JSON.parse(typeof body === 'string' ? body : String(body ?? ''));
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed.slice(0, MAX_REPORTS_PER_REQUEST) : [parsed];
  return items.map(normalizeOne).filter(report => report && report.directive);
}

export function createCspReportCollector({
  log,
  now = Date.now,
  windowMs = 10 * 60 * 1000,
  maxSignatures = 1000,
} = {}) {
  // signature -> { until, suppressed }
  const seen = new Map();

  function record(report) {
    const signature = [report.disposition, report.directive, report.blocked, report.source, report.line, report.sample].join('|');
    const at = now();
    const entry = seen.get(signature);
    if (entry && entry.until > at) {
      entry.suppressed += 1;
      return false;
    }
    const suppressed = entry ? entry.suppressed : 0;
    seen.delete(signature);
    if (seen.size >= maxSignatures) seen.delete(seen.keys().next().value);
    seen.set(signature, { until: at + windowMs, suppressed: 0 });
    // A report-only violation is data for the rollout; an enforced one means
    // something was actually blocked for a visitor.
    const emit = report.disposition === 'enforce' ? log.warn : log.info;
    emit('csp.violation', { ...report, suppressedSinceLast: suppressed });
    return true;
  }

  return {
    record,
    // Returns how many reports were logged (the rest were duplicates or junk).
    handle(body) {
      let logged = 0;
      for (const report of parseCspReports(body)) {
        if (record(report)) logged += 1;
      }
      return logged;
    },
  };
}

// POST CSP_REPORT_PATH. Registers the two report content types (Fastify rejects
// unknown types with 415) with a small body limit of their own.
export function registerCspReportRoute(app, { collector, limiter } = {}) {
  app.fastify.addContentTypeParser(
    CSP_REPORT_CONTENT_TYPES,
    { parseAs: 'string', bodyLimit: CSP_REPORT_MAX_BYTES },
    (_request, body, done) => done(null, body)
  );
  const handler = (req, res) => {
    try {
      collector.handle(req.body);
    } catch (error) {
      console.error('[CSP] report handling failed:', error?.message || error);
    }
    res.set({ 'Cache-Control': 'no-store' });
    res.status(204).send();
  };
  const args = [CSP_REPORT_PATH];
  if (limiter) args.push(limiter);
  args.push(handler);
  app.post(...args);
}
