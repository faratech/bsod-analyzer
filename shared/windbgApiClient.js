const DEFAULT_WINDBG_API_BASE_URL = 'https://windbg-api.stack-tech.net';

function normalizeWinDbgApiBaseUrl(value) {
  const raw = String(value || DEFAULT_WINDBG_API_BASE_URL).trim();
  if (!raw) return DEFAULT_WINDBG_API_BASE_URL;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme
    .replace(/\/+$/, '')
    .replace(/\/api\/v1$/i, '')
    .replace(/\/api$/i, '');
}

function winDbgApiUrl(baseUrl, path) {
  return `${normalizeWinDbgApiBaseUrl(baseUrl)}/api/v1${path}`;
}

async function readJsonResponse(response, context) {
  const text = await response.text();
  let body = null;
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      if (response.ok) {
        throw new Error(`${context} returned invalid JSON: ${text.slice(0, 200)}`);
      }
    }
  }

  if (!response.ok) {
    const message = body?.message || body?.error || text || response.statusText || 'request failed';
    throw new Error(`${context} failed with status ${response.status}: ${message}`);
  }

  return body || {};
}

function appendFile(formData, fileBuffer, fileName) {
  const blob = new Blob([fileBuffer], { type: 'application/octet-stream' });
  formData.append('file', blob, fileName || 'upload.dmp');
}

async function submitWinDbgJob({
  baseUrl,
  apiKey,
  fileBuffer,
  fileName,
  priority,
  fetchImpl = fetch,
  signal
}) {
  if (!apiKey) {
    throw new Error('WINDBG_API_KEY is required');
  }

  const formData = new FormData();
  appendFile(formData, fileBuffer, fileName);
  if (priority !== undefined && priority !== null) {
    formData.append('priority', String(priority));
  }

  const response = await fetchImpl(winDbgApiUrl(baseUrl, '/jobs'), {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey
    },
    body: formData,
    signal
  });

  const body = await readJsonResponse(response, 'WinDBG job submit');
  const jobId = body.job_id || body.id;
  if (!jobId || typeof jobId !== 'string') {
    throw new Error('WinDBG job submit response did not include job_id');
  }

  return { ...body, job_id: jobId };
}

async function getWinDbgJob({
  baseUrl,
  apiKey,
  jobId,
  fetchImpl = fetch,
  signal
}) {
  if (!jobId || typeof jobId !== 'string') {
    throw new Error('jobId is required');
  }

  const headers = {
    'Cache-Control': 'no-cache, no-store',
    'Pragma': 'no-cache'
  };
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }

  const response = await fetchImpl(winDbgApiUrl(baseUrl, `/jobs/${encodeURIComponent(jobId)}`), {
    headers,
    signal
  });

  return await readJsonResponse(response, 'WinDBG job status');
}

function mapWinDbgJobStatus(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'complete' || normalized === 'completed') return 'completed';
  if (normalized === 'running' || normalized === 'validating' || normalized === 'processing' || normalized === 'analyzing') {
    return 'processing';
  }
  if (normalized === 'failed' || normalized === 'timed_out' || normalized === 'timed-out'
      || normalized === 'cancelled' || normalized === 'canceled') {
    return 'failed';
  }
  return 'pending';
}

function toUnixSeconds(value) {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

function processingSeconds(job) {
  const started = Date.parse(job?.started_at || '');
  const completed = Date.parse(job?.completed_at || '');
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
    return undefined;
  }
  return Math.round((completed - started) / 1000);
}

function toLegacyWinDbgStatusResponse(job, uid) {
  const status = mapWinDbgJobStatus(job?.status);
  return {
    success: true,
    data: {
      uid,
      status,
      created_at: toUnixSeconds(job?.submitted_at),
      started_at: toUnixSeconds(job?.started_at),
      completed_at: toUnixSeconds(job?.completed_at),
      analysis_available: status === 'completed',
      output_file_size: undefined,
      processing_time_seconds: processingSeconds(job),
      error_message: job?.error || undefined,
      queue_position: job?.queue_position ?? (status === 'pending' ? 1 : 0)
    }
  };
}

function extractWinDbgAnalysisText(job) {
  const result = job?.result;
  if (typeof result === 'string' && result.trim()) {
    return result;
  }

  if (result && typeof result === 'object') {
    if (typeof result.stdout === 'string' && result.stdout.trim()) {
      return result.stdout;
    }

    if (result.sections && typeof result.sections === 'object') {
      const sections = Object.entries(result.sections)
        .filter(([, value]) => typeof value === 'string' && value.trim())
        .map(([name, value]) => `===== ${name} =====\n${value}`);
      if (sections.length > 0) {
        return sections.join('\n\n');
      }
    }

    return JSON.stringify(result, null, 2);
  }

  return '';
}

export {
  DEFAULT_WINDBG_API_BASE_URL,
  extractWinDbgAnalysisText,
  getWinDbgJob,
  mapWinDbgJobStatus,
  normalizeWinDbgApiBaseUrl,
  submitWinDbgJob,
  toLegacyWinDbgStatusResponse
};
