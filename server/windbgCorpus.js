// Full WinDBG analysis corpus in BigQuery (training data for the BSOD AI).
//
// Every completed WinDbg-API job this server downloads is streamed, complete and
// unredacted, into <project>.bsod_corpus.windbg_analyses (schema:
// bigquery/windbg_analyses.schema.json). Only after BigQuery accepts the row is
// the job acknowledged to WinDbg-API (POST /api/v1/jobs/archived), which lets the
// WinDBG server prune its own copy of the raw output after its retention window.
// History from before this existed is loaded by scripts/windbg-corpus-export.py,
// which must emit the same row shape (see buildCorpusRow).
//
// Best-effort: failures are logged and never affect the analysis response; a job
// that is not acknowledged simply stays on the WinDBG server.
import { createGcpMetadataAuth } from './gcpMetadata.js';
import { mapWinDbgJobStatus } from '../shared/windbgApiClient.js';

const BIGQUERY = 'https://bigquery.googleapis.com/bigquery/v2';
const IDENTIFIER_RE = /^[A-Za-z0-9_-]+$/;
const INSERT_TIMEOUT_MS = 30_000;
// insertAll requests are capped at 10 MB; leave headroom for the envelope.
export const MAX_ROW_BYTES = 9 * 1024 * 1024;
const RECENT_LIMIT = 2000;

function text(value) {
  return value === undefined || value === null || value === '' ? null : String(value);
}

function isoOrNull(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function resultObject(result) {
  if (result && typeof result === 'object' && !Array.isArray(result)) return result;
  if (typeof result === 'string' && result.trim()) {
    try {
      const parsed = JSON.parse(result);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* raw text result */ }
    return { stdout: result };
  }
  return null;
}

// One corpus row. `result` is the complete job result object; the extracted
// columns are conveniences for querying and clustering.
export function buildCorpusRow(job, { ingestSource = 'live', fileHash, fileSizeBytes, now = Date.now() } = {}) {
  const result = resultObject(job?.result);
  const signal = result?.ai_signal && typeof result.ai_signal === 'object' ? result.ai_signal : {};
  const bugcheck = signal.bugcheck || {};
  const crash = signal.crash || {};
  const target = signal.target || {};
  const size = Number(fileSizeBytes ?? job?.file_size_bytes);
  return {
    job_id: String(job.id),
    ingest_source: ingestSource,
    ingested_at: new Date(now).toISOString(),
    file_hash: text(fileHash),
    status: text(job.status),
    mode: text(job.mode),
    dump_type: text(job.dump_type),
    canonical_type: text(job.canonical_type),
    detected_profile: text(job.detected_profile),
    variant_key: text(job.variant_key),
    file_size_bytes: Number.isFinite(size) && size > 0 ? Math.trunc(size) : null,
    submitted_at: isoOrNull(job.submitted_at),
    started_at: isoOrNull(job.started_at),
    completed_at: isoOrNull(job.completed_at),
    error: text(job.error),
    error_category: text(job.error_category),
    failure_reason: text(job.failure_reason),
    bugcheck_code: text(bugcheck.code),
    bugcheck_name: text(bugcheck.name),
    failure_bucket: text(crash.failureBucketId),
    symbol_name: text(crash.symbolName),
    module_name: text(crash.moduleName),
    image_name: text(crash.imageName),
    image_version: text(crash.imageVersion),
    process_name: text(crash.processName),
    os_version: text(target.os_version),
    arch: text(target.arch),
    raw_output_pruned: result?.raw_output_pruned === true,
    result
  };
}

// insertAll takes a JSON column as a string holding JSON. `stdout` is the
// concatenation of the per-command `sections`, so it is the one field dropped
// (and flagged) if a rare giant result would exceed the request limit.
export function toInsertAllRow(row) {
  let result = row.result;
  let json = result === null ? null : JSON.stringify(result);
  if (json && Buffer.byteLength(json) > MAX_ROW_BYTES && typeof result.stdout === 'string') {
    result = { ...result, stdout: null, stdout_omitted_for_size: true };
    json = JSON.stringify(result);
  }
  return { ...row, result: json };
}

export function createWinDbgCorpusRecorder({
  dataset = 'bsod_corpus',
  table = 'windbg_analyses',
  projectId,
  getAccessToken,
  fetchImpl = globalThis.fetch,
  markArchived = async () => {},
  isEnabled = () => true,
  logger = console,
  now = () => Date.now()
} = {}) {
  if (!IDENTIFIER_RE.test(dataset) || !IDENTIFIER_RE.test(table)) {
    throw new TypeError('BigQuery dataset/table names must be plain identifiers');
  }
  const { accessToken, projectIdentifier } = createGcpMetadataAuth({ projectId, getAccessToken, fetchImpl });
  const recent = new Set(); // job ids already recorded by this instance

  async function insert(row) {
    const projectName = await projectIdentifier();
    const res = await fetchImpl(
      `${BIGQUERY}/projects/${projectName}/datasets/${dataset}/tables/${table}/insertAll`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: [{ insertId: row.job_id, json: toInsertAllRow(row) }] }),
        signal: AbortSignal.timeout(INSERT_TIMEOUT_MS)
      }
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error?.message || `BigQuery insertAll HTTP ${res.status}`);
    if (body.insertErrors?.length) {
      const first = body.insertErrors[0]?.errors?.[0];
      throw new Error(`BigQuery rejected row: ${first?.location || ''} ${first?.message || 'unknown error'}`.trim());
    }
  }

  function remember(jobId) {
    recent.add(jobId);
    if (recent.size > RECENT_LIMIT) recent.delete(recent.values().next().value);
  }

  // Returns true once the row is stored (and acknowledged, best-effort).
  async function record(job, meta = {}) {
    if (!isEnabled() || !job?.id || mapWinDbgJobStatus(job.status) !== 'completed' || recent.has(job.id)) return false;
    const row = buildCorpusRow(job, { ...meta, ingestSource: 'live', now: now() });
    try {
      await insert(row);
    } catch (error) {
      logger.warn?.('corpus.insert_failed', { jobId: row.job_id, error: error?.message || String(error) });
      return false;
    }
    remember(row.job_id);
    try {
      await markArchived([row.job_id]);
    } catch (error) {
      logger.warn?.('corpus.ack_failed', { jobId: row.job_id, error: error?.message || String(error) });
    }
    return true;
  }

  return { record };
}
