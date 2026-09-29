// Durable capture of each WinDBG analysis into WindowsForum's wf_crash_signal
// table (POST <WF_CRASH_SIGNAL_URL>/crash-signal, X-API-Key: WF_CRASH_SIGNAL_KEY).
// The analyzer's own cache is 7-day TTL, so without this the analyses are lost to
// the forum's crash-trend tracking. Both analysis paths feed it:
// - external API: server.js generateAIReportFromWinDBG records its final report;
// - browser: /api/gemini/generateContent only sees the AI half of the report (the
//   browser merges the WinDBG fields in itself), so recordWebAnalysis re-reads the
//   WinDBG evidence from the upstream job and applies the same merge. Nothing is
//   taken from the client-built prompt, which is only checked to have carried
//   that evidence.
// The ingest (fastapi-app ideaengine_crash_router.py) is INSERT IGNORE on a unique
// file_hash, so the first row per dump wins and re-sends are no-ops.
//
// Fire-and-forget and fully guarded: a no-op unless both the URL and key are set,
// and nothing here throws or rejects into the analysis path.
import { normalizeAnalysisReport, promptIncludesWinDbgSignal } from './analysisReport.js';
import {
  mapStructuredSignalToReport,
  mergeReportWithWinDbgFields,
  parseWinDbgOutput
} from '../shared/windbgReportFields.js';

export const DEFAULT_CRASH_SIGNAL_TIMEOUT_MS = 5_000;
const CONFIDENCE_FIELDS = ['summary', 'probableCause', 'culprit', 'bugCheck', 'bugCheckCode', 'systemInfo'];
const MAX_EXCERPT_CHARS = 2000;

export function buildCrashSignalPayload(report, fileHash) {
  if (!fileHash || !report || typeof report !== 'object') return null;
  const bc = report.bugCheck || {};
  const sys = report.systemInfo || {};
  const loc = report.crashLocation || {};
  const parsed = CONFIDENCE_FIELDS.reduce((n, k) => n + (report[k] ? 1 : 0), 0);
  return {
    file_hash: String(fileHash).slice(0, 64),
    bug_check_code: bc.code || report.bugCheckCode || null,
    bug_check_name: bc.name || null,
    faulty_driver: report.culprit || loc.module || null,
    windows_version: sys.windowsVersion || null,
    crash_time: null,
    parse_confidence: Math.round((parsed / CONFIDENCE_FIELDS.length) * 100),
    raw_excerpt: typeof report.summary === 'string' ? report.summary.slice(0, MAX_EXCERPT_CHARS) : ''
  };
}

// The AI report plus deterministic WinDBG fields, merged exactly as the API path
// (generateAIReportFromWinDBG) and the browser (services/geminiProxy.ts) do.
export function enrichWithWinDbgEvidence(report, { structured, analysisText } = {}) {
  const merged = mergeReportWithWinDbgFields(
    report,
    mapStructuredSignalToReport(structured),
    parseWinDbgOutput(analysisText)
  );
  return normalizeAnalysisReport(merged) || merged;
}

export function createCrashSignalRecorder({
  url,
  key,
  timeoutMs = DEFAULT_CRASH_SIGNAL_TIMEOUT_MS,
  fetchImpl = fetch,
  logger = console
} = {}) {
  const endpoint = url ? `${String(url).replace(/\/+$/, '')}/crash-signal` : '';
  const enabled = Boolean(endpoint && key);

  async function record(report, fileHash) {
    if (!enabled) return;
    let timer;
    try {
      const payload = buildCrashSignalPayload(report, fileHash);
      if (!payload) return;
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
        body: JSON.stringify(payload)
      });
      if (!response?.ok) logger.warn('crash_signal.http', { status: response?.status });
    } catch (error) {
      logger.warn('crash_signal.failed', { error: error?.message || String(error) });
    } finally {
      clearTimeout(timer);
    }
  }

  // Browser analyses: loadEvidence() returns the upstream job's
  // { analysisText, analysisSignalText, structured } (extractWinDbgAnalysisPackage).
  async function recordWebAnalysis({ fileHash, promptText, aiReport, loadEvidence }) {
    if (!enabled || !fileHash || !aiReport || typeof loadEvidence !== 'function') return;
    try {
      const evidence = await loadEvidence();
      if (!evidence?.analysisText) {
        logger.warn('crash_signal.web_skipped', { reason: 'no_windbg_evidence' });
        return;
      }
      // The AI's culprit and summary only count when it was shown the real
      // structured evidence (the browser forwards analysisSignalText verbatim).
      const hasSignal = typeof evidence.analysisSignalText === 'string' && evidence.analysisSignalText.trim();
      if (hasSignal && !promptIncludesWinDbgSignal(promptText, evidence.analysisSignalText)) {
        logger.warn('crash_signal.web_skipped', { reason: 'evidence_mismatch' });
        return;
      }
      await record(enrichWithWinDbgEvidence(aiReport, evidence), fileHash);
    } catch (error) {
      logger.warn('crash_signal.web_failed', { error: error?.message || String(error) });
    }
  }

  return { enabled, record, recordWebAnalysis };
}
