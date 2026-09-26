// Pure AI-report parsing/validation shared by server.js and offline scripts
// (scripts/regenerate-ai-reports.mjs). No I/O.
import { WINDBG_OUTPUT_MARKER } from '../shared/promptTemplates.js';

// Per-dump tail of the WinDBG prompt (after the shared, cache-stable
// WINDBG_PREFIX): file info plus the structured signal or a raw excerpt.
export function buildWinDbgEvidence({ fileName, dumpType, fileSize, analysisForPrompt, structured }) {
  return `**File Information:**
- Filename: ${fileName}
- Dump Type: ${dumpType}
- File Size: ${fileSize} bytes

${WINDBG_OUTPUT_MARKER}
${structured ? 'Relevant structured JSON extracted from the WinDBG API result. Full stdout is intentionally omitted.' : 'Relevant WinDBG crash excerpt from the raw output.'}
\`\`\`${structured ? 'json' : ''}
${analysisForPrompt}
\`\`\``;
}
export function extractJsonText(text) {
  let jsonText = String(text || '').trim();
  if (jsonText.startsWith('```json')) {
    jsonText = jsonText.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  } else if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }
  jsonText = jsonText.trim();
  if (!jsonText.startsWith('{')) {
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonText = jsonMatch[0];
  }
  return jsonText;
}

export function sanitizeString(value, maxLength) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

export function sanitizeStringArray(value, maxItems = 12, maxLength = 600) {
  if (!Array.isArray(value)) return null;
  const sanitized = value
    .map(item => sanitizeString(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
  return sanitized.length > 0 ? sanitized : null;
}

export function normalizeAnalysisReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return null;

  const summary = sanitizeString(report.summary, 1000);
  const probableCause = sanitizeString(report.probableCause, 4000);
  const culprit = sanitizeString(report.culprit, 512);
  const recommendations = sanitizeStringArray(report.recommendations, 12, 800);

  if (!summary || !probableCause || !culprit || !recommendations) {
    return null;
  }

  const normalized = {
    ...report,
    summary,
    probableCause,
    culprit,
    recommendations
  };

  if (Array.isArray(normalized.driverWarnings)) {
    // Filter out malformed driver warnings (AI sometimes returns entries with empty fields)
    normalized.driverWarnings = normalized.driverWarnings
      .map(w => ({
        driverName: sanitizeString(w.driverName || w.name, 256),
        displayName: sanitizeString(w.displayName || w.name || w.driverName, 512),
        manufacturer: sanitizeString(w.manufacturer, 256) || 'Unknown',
        category: sanitizeString(w.category, 128) || 'other',
        issues: sanitizeStringArray(w.issues, 10, 500) ||
          (sanitizeString(w.description, 500) ? [sanitizeString(w.description, 500)] : []),
        recommendations: sanitizeStringArray(w.recommendations, 10, 500) || [],
        isAssociatedWithBugCheck: !!w.isAssociatedWithBugCheck
      }))
      .filter(w => w.driverName && w.displayName && w.manufacturer)
      .slice(0, 20);
  }
  if (Array.isArray(normalized.parameterAnalysis)) {
    // Filter out malformed parameter analysis entries
    normalized.parameterAnalysis = normalized.parameterAnalysis
      .filter(p => p && typeof p === 'object' &&
        p.rawValue && typeof p.rawValue === 'string' && p.rawValue.trim() &&
        p.decoded && typeof p.decoded === 'string' && p.decoded.trim()
      )
      .slice(0, 12);
  }
  // Ensure hardwareError has valid structure if present
  if (normalized.hardwareError && typeof normalized.hardwareError === 'object') {
    if (normalized.hardwareError.type && !normalized.hardwareError.errorType) {
      normalized.hardwareError.errorType = sanitizeString(normalized.hardwareError.type, 256) || 'Hardware error';
    }
    if (typeof normalized.hardwareError.details === 'string') {
      normalized.hardwareError.details = [normalized.hardwareError.details];
    }
    normalized.hardwareError.details = sanitizeStringArray(normalized.hardwareError.details, 12, 800) || [];
    normalized.hardwareError.recommendations = sanitizeStringArray(normalized.hardwareError.recommendations, 10, 800) || [];
    normalized.hardwareError.component = sanitizeString(normalized.hardwareError.component, 256) || 'Unknown';
    normalized.hardwareError.severity = sanitizeString(normalized.hardwareError.severity, 128) || 'fatal';
    normalized.hardwareError.isHardwareError = !!normalized.hardwareError.isHardwareError || !!normalized.hardwareError.errorType;
    if (!normalized.hardwareError.isHardwareError) {
      delete normalized.hardwareError; // Remove if not actually a hardware error
    }
  }

  return normalized;
}

export function parseAndValidateAnalysisReport(text) {
  const jsonText = extractJsonText(text);
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { valid: false, reason: 'AI response was not valid JSON' };
  }

  const report = normalizeAnalysisReport(parsed);
  if (!report) {
    return { valid: false, reason: 'AI response did not match the analysis report schema' };
  }

  return { valid: true, report, text: JSON.stringify(report) };
}
