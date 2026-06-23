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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableSubmitError(error) {
  const status = Number(error?.upstreamStatus);
  return error?.code === 'WINDBG_UPSTREAM_ERROR'
    && (status === 520 || status === 522 || status === 524 || status === 525);
}

function escapeMultipartValue(value) {
  return String(value || '').replace(/["\r\n]/g, '_');
}

function buildMultipartSubmitBody({ fileBuffer, fileName, priority }) {
  const boundary = `----windbg-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  const filePartHeader = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${escapeMultipartValue(fileName || 'upload.dmp')}"`,
    'Content-Type: application/octet-stream',
    '',
    ''
  ].join('\r\n');
  const parts = [filePartHeader, fileBuffer, '\r\n'];

  if (priority !== undefined && priority !== null) {
    parts.push(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="priority"',
        '',
        String(priority),
        ''
      ].join('\r\n')
    );
  }

  parts.push(`--${boundary}--\r\n`);
  const body = new Blob(parts, { type: `multipart/form-data; boundary=${boundary}` });
  return {
    body,
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.size)
    }
  };
}

async function readJsonResponse(response, context) {
  const text = await response.text();
  let body = null;
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      if (response.ok) {
        // A 2xx with a non-JSON / HTML body (e.g. a proxy error page). Surface a
        // coded soft-error so the API proxy can map it to a clean 502 instead
        // of leaking a raw parse failure as a 500.
        const err = new Error(`${context} returned invalid JSON: ${text.slice(0, 200)}`);
        err.code = 'WINDBG_UPSTREAM_INVALID_JSON';
        err.upstreamStatus = response.status;
        throw err;
      }
    }
  }

  if (!response.ok) {
    const message = body?.message || body?.error || text || response.statusText || 'request failed';
    const err = new Error(`${context} failed with status ${response.status}: ${message}`);
    err.code = 'WINDBG_UPSTREAM_ERROR';
    err.upstreamStatus = response.status;
    throw err;
  }

  return body || {};
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

  const maxAttempts = 2;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const multipart = buildMultipartSubmitBody({ fileBuffer, fileName, priority });

    try {
      const response = await fetchImpl(winDbgApiUrl(baseUrl, '/jobs'), {
        method: 'POST',
        headers: {
          'X-API-Key': apiKey,
          ...multipart.headers
        },
        body: multipart.body,
        signal
      });

      const body = await readJsonResponse(response, 'WinDBG job submit');
      const jobId = body.job_id || body.id;
      if (!jobId || typeof jobId !== 'string') {
        throw new Error('WinDBG job submit response did not include job_id');
      }

      return { ...body, job_id: jobId };
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableSubmitError(error)) {
        throw error;
      }
      await sleep(750);
    }
  }

  throw lastError;
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

// ── Defensive coercion (robust JSON handling for all possibilities) ───────────
// The upstream is strongly typed today, but a proxy, a config change, or an older
// server build can hand us strings where we expect bools/ints, or vice-versa.
function coerceBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes') return true;
    if (v === 'false' || v === '0' || v === 'no' || v === '') return false;
  }
  return undefined;
}

function coerceInt(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const n = parseInt(value.trim(), 10);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

// Resolve a cdb section by the *sanitized command suffix* instead of a hardcoded
// STEP_NN_ index. Section keys are generated server-side as
// `STEP_{i+1:D2}_{sanitize(cmd)}` from the configured command chain, so the index
// of e.g. `!analyze -v` differs between the kernel (STEP_04), user (STEP_02), and
// dotnet (STEP_03) chains. Matching on the suffix keeps extraction correct across
// every chain and survives any reordering of config.json.
function findSection(sections, suffixRe) {
  if (!sections || typeof sections !== 'object') return undefined;
  for (const key of Object.keys(sections)) {
    const match = /^STEP_\d+_(.+)$/.exec(key);
    if (match && suffixRe.test(match[1])) {
      const value = sections[key];
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) return value.join('\n');
    }
  }
  return undefined;
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
      error_category: job?.error_category || undefined,
      // Pass the raw upstream status through so the proxy/UI can see an unmapped
      // value rather than silently treating an unknown status as 'pending'.
      raw_status: typeof job?.status === 'string' ? job.status : undefined,
      queue_position: job?.queue_position ?? (status === 'pending' ? 1 : 0)
    }
  };
}

function compactText(value, maxLength = 1600) {
  if (typeof value !== 'string') return undefined;
  const text = value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trim();
  if (!text) return undefined;
  if (text.length <= maxLength) return text;
  const head = Math.floor(maxLength * 0.75);
  const tail = maxLength - head - 40;
  return `${text.slice(0, head)}\n\n[... ${text.length - head - tail} bytes omitted ...]\n\n${text.slice(-tail)}`;
}

function compactObject(value, allowedKeys) {
  if (!value || typeof value !== 'object') return undefined;
  const result = {};
  for (const key of allowedKeys) {
    const item = value[key];
    if (item !== undefined && item !== null && item !== '') {
      result[key] = item;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function extractField(text, regex) {
  if (typeof text !== 'string') return undefined;
  const match = text.match(regex);
  return match?.[1]?.trim();
}

function extractRepeatedFields(text, regex) {
  if (typeof text !== 'string') return [];
  return [...text.matchAll(regex)]
    .map(match => match[1]?.trim())
    .filter(Boolean);
}

function normalizeBugCheckCode(code) {
  if (!code) return undefined;
  const raw = String(code).trim();
  const hex = raw.replace(/^0x/i, '').replace(/^0+/, '') || '0';
  return `0x${hex.toUpperCase()}`;
}

function parseKeyValues(analyzeText) {
  if (typeof analyzeText !== 'string') return undefined;
  const wanted = /^(Analysis\.|Bugcheck\.|Dump\.Attributes\.|Failure\.|Stack\.Pointer$|WER\.System\.BIOSRevision$|Hypervisor\.Flags\.AnyHypervisorPresent$|Hypervisor\.RootFlags\.IsHyperV$)/;
  const entries = {};
  const matches = [...analyzeText.matchAll(/Key\s+:\s+(.+?)\n\s+Value:\s+(.+?)(?=\n\s*\n|\n\s*Key\s+:|$)/g)];
  for (const match of matches) {
    const key = match[1]?.trim();
    const value = match[2]?.trim();
    if (key && value && wanted.test(key)) {
      entries[key] = value;
    }
  }
  return Object.keys(entries).length > 0 ? entries : undefined;
}

function parseBugCheckDescription(analyzeText) {
  if (typeof analyzeText !== 'string') return {};
  const titleMatch = analyzeText.match(/(?:^|\n)([A-Z0-9_]+)\s+\(([0-9a-fA-F]+)\)\n([\s\S]*?)(?=\nArguments:|\nDebugging Details:|\nBUGCHECK_CODE:|$)/);
  if (!titleMatch) return {};
  return {
    name: titleMatch[1],
    code: normalizeBugCheckCode(titleMatch[2]),
    description: compactText(titleMatch[3], 700)
  };
}

function parseBugCheckSection(sectionText) {
  if (typeof sectionText !== 'string') return {};
  const code = extractField(sectionText, /Bugcheck code\s+([0-9a-fA-F]+)/i);
  const args = extractField(sectionText, /Arguments\s+(.+)/i);
  return {
    code: normalizeBugCheckCode(code),
    parameters: args ? args.split(/\s+/).filter(Boolean) : undefined
  };
}

function parseAnalyzeFields(analyzeText) {
  const description = parseBugCheckDescription(analyzeText);
  const code = extractField(analyzeText, /BUGCHECK_CODE:\s*([0-9a-fA-F]+)/i);
  const p = [1, 2, 3, 4].map(index => extractField(analyzeText, new RegExp(`BUGCHECK_P${index}:\\s*([^\\n]+)`, 'i'))).filter(Boolean);
  return {
    bugcheck: {
      ...description,
      code: description.code || normalizeBugCheckCode(code),
      parameters: p.length > 0 ? p : undefined,
      keyValues: parseKeyValues(analyzeText)
    },
    crash: {
      failureBucketId: extractField(analyzeText, /FAILURE_BUCKET_ID:\s*(.+)/i),
      failureHash: extractField(analyzeText, /FAILURE_ID_HASH:\s*(.+)/i) || extractField(analyzeText, /Failure\.Hash\s*\n\s*Value:\s*(.+)/i),
      symbolName: extractField(analyzeText, /SYMBOL_NAME:\s*(.+)/i),
      moduleName: extractField(analyzeText, /MODULE_NAME:\s*(\S+)/i),
      imageName: extractField(analyzeText, /IMAGE_NAME:\s*(\S+)/i),
      imageVersion: extractField(analyzeText, /IMAGE_VERSION:\s*(.+)/i),
      processName: extractField(analyzeText, /PROCESS_NAME:\s*(\S+)/i),
      faultingThread: extractField(analyzeText, /FAULTING_THREAD:\s*(\S+)/i),
      readAddress: extractField(analyzeText, /READ_ADDRESS:\s*(.+)/i),
      stackCommand: extractField(analyzeText, /STACK_COMMAND:\s*(.+)/i),
      followup: extractField(analyzeText, /Followup:\s*(.+)/i)
    },
    blackboxes: extractRepeatedFields(analyzeText, /\n(BLACKBOX[A-Z0-9_]+):\s*1\b/g)
  };
}

function cleanParsedStackFrame(frame) {
  if (!frame || typeof frame !== 'object') return undefined;
  const symbol = typeof frame.symbol === 'string'
    ? frame.symbol.replace(/^\s*:\s*/, '').trim()
    : undefined;
  return compactObject({
    frame: frame.frame,
    sp: frame.sp,
    ret_addr: frame.ret_addr,
    symbol: compactText(symbol, 280)
  }, ['frame', 'sp', 'ret_addr', 'symbol']);
}

function stackModuleNames(stackFrames) {
  const names = new Set();
  for (const frame of stackFrames || []) {
    const symbol = frame?.symbol || '';
    for (const match of symbol.matchAll(/\b([A-Za-z0-9_.$-]+)!/g)) {
      names.add(match[1].toLowerCase());
    }
  }
  return names;
}

const THIRD_PARTY_MODULE_HINT = /^(nv|ati|amd|igdk|rtk|rtc|netwtw|e1|ath|killer|bcm|qca|asw|avg|sym|kl|avp|vm|vbox|tap|wintun|ndisimplatform|rz|corsair|logi|steel|asus|msi|gigabyte|aorus|evga|elam|edev|epf)/i;

function moduleNameFromImage(imageName) {
  if (!imageName || typeof imageName !== 'string') return undefined;
  return imageName.replace(/\.(sys|dll|exe)$/i, '').toLowerCase();
}

function parseModuleDetails(lmvText, wantedNames) {
  if (typeof lmvText !== 'string' || wantedNames.size === 0) return new Map();
  const details = new Map();
  let activeName = null;
  let active = null;

  const finish = () => {
    if (activeName && active && Object.keys(active).length > 0) {
      details.set(activeName, active);
    }
    activeName = null;
    active = null;
  };

  for (const line of lmvText.split('\n')) {
    const header = line.match(/^[0-9a-fA-F`]+\s+[0-9a-fA-F`]+\s+([A-Za-z0-9_.$-]+)\s+/);
    if (header) {
      finish();
      const name = header[1].toLowerCase();
      if (wantedNames.has(name)) {
        activeName = name;
        active = {};
      }
      continue;
    }
    if (!active) continue;

    const field = line.match(/^\s*(Image name|Image path|File version|Product version|CompanyName|ProductName|FileDescription|Timestamp):\s*(.+?)\s*$/);
    if (field) {
      const key = field[1]
        .toLowerCase()
        .replace(/\s+([a-z])/g, (_, c) => c.toUpperCase());
      active[key] = compactText(field[2], 220);
    }
  }
  finish();
  return details;
}

function selectRelevantModules(parsedModules, crash, stackFrames, lmvText) {
  if (!Array.isArray(parsedModules)) return undefined;
  const wanted = stackModuleNames(stackFrames);
  for (const value of [crash?.moduleName, moduleNameFromImage(crash?.imageName)]) {
    if (value) wanted.add(String(value).toLowerCase());
  }
  for (const mod of parsedModules) {
    const name = String(mod?.name || '');
    if (THIRD_PARTY_MODULE_HINT.test(name)) {
      wanted.add(name.toLowerCase());
    }
  }

  const details = parseModuleDetails(lmvText, wanted);
  const selected = [];
  for (const mod of parsedModules) {
    const name = String(mod?.name || '');
    if (!name || !wanted.has(name.toLowerCase())) continue;
    selected.push({
      ...compactObject(mod, ['name', 'status', 'pdb_path', 'source']),
      details: details.get(name.toLowerCase())
    });
    if (selected.length >= 30) break;
  }
  return selected.length > 0 ? selected : undefined;
}

function selectDebuggerWarnings(result, parsed, sections) {
  const warnings = new Set();
  if (typeof result?.stderr === 'string' && result.stderr.trim()) {
    warnings.add(`stderr: ${compactText(result.stderr, 300)}`);
  }
  for (const err of parsed?.errors || []) {
    if (typeof err === 'string' && err.trim()) warnings.add(compactText(err, 300));
  }

  const warningPattern = /(ERROR:|Unable to|unable to|could not|Cannot get|not supported|No export|failed|Invalid)/;
  for (const [name, value] of Object.entries(sections || {})) {
    const text = typeof value === 'string'
      ? value
      : Array.isArray(value) ? value.join('\n') : '';
    if (!text) continue;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && warningPattern.test(trimmed)) {
        warnings.add(`${name}: ${compactText(trimmed, 260)}`);
        if (warnings.size >= 25) return [...warnings];
      }
    }
  }
  return warnings.size > 0 ? [...warnings] : undefined;
}

// Coerce the job `result` into a plain object regardless of how it arrives:
// object · JSON-encoded string (double-encoded blobs) · plain cdb text · array · null.
function coerceResultObject(result) {
  if (result == null) return {};
  if (typeof result === 'string') {
    const trimmed = result.trim();
    if (!trimmed) return {};
    if (trimmed[0] === '{' || trimmed[0] === '[') {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch { /* not JSON — treat as raw stdout text below */ }
    }
    return { stdout: result };
  }
  if (Array.isArray(result)) return {};
  if (typeof result === 'object') return result;
  return {};
}

function getResultObject(job) {
  return coerceResultObject(job?.result);
}

function getSectionsObject(result) {
  const sections = result?.sections && typeof result.sections === 'object' && !Array.isArray(result.sections)
    ? { ...result.sections }
    : {};
  for (const [key, value] of Object.entries(result || {})) {
    if (/^STEP_\d+_/.test(key) && sections[key] === undefined) {
      sections[key] = value;
    }
  }
  return sections;
}

function removeEmpty(value) {
  if (Array.isArray(value)) {
    const arr = value.map(removeEmpty).filter(item => item !== undefined);
    return arr.length > 0 ? arr : undefined;
  }
  if (value && typeof value === 'object') {
    const obj = {};
    for (const [key, item] of Object.entries(value)) {
      const cleaned = removeEmpty(item);
      if (cleaned !== undefined) obj[key] = cleaned;
    }
    return Object.keys(obj).length > 0 ? obj : undefined;
  }
  if (value === undefined || value === null || value === '') return undefined;
  return value;
}

function extractRelevantWinDbgSignal(job) {
  const result = getResultObject(job);

  // Prefer the authoritative signal computed server-side (Phase 3) when it is
  // present and well-formed; otherwise fall back to local extraction below. This
  // keeps older/partial server builds working and tolerates malformed payloads.
  const serverSignal = result.ai_signal;
  if (serverSignal && typeof serverSignal === 'object' && !Array.isArray(serverSignal)
      && serverSignal.schema === 'windbg_crash_signal_v1') {
    const cleanedServer = removeEmpty(serverSignal) || {};
    if (Object.keys(cleanedServer).length > 1) return cleanedServer;
  }

  const parsed = result.parsed && typeof result.parsed === 'object' ? result.parsed : {};
  const sections = getSectionsObject(result);

  // Resolve sections by command suffix, not hardcoded index — works for the
  // kernel, user, and dotnet command chains alike (see findSection).
  const analyzeSection = findSection(sections, /^analyze_v$/);
  const bugcheckSectionText = findSection(sections, /^bugcheck$/);
  const vertargetSection = findSection(sections, /^vertarget$/);
  const threadSection = findSection(sections, /^thread$/);
  const irqlSection = findSection(sections, /^irql$/);
  const lmvSection = findSection(sections, /^lmv$/);

  const analyzeText = analyzeSection || (typeof result.stdout === 'string' ? result.stdout : '') || '';
  const analyzeFields = parseAnalyzeFields(analyzeText);
  const bugcheckSection = parseBugCheckSection(bugcheckSectionText);
  const stackFrames = Array.isArray(parsed.stack_frames)
    ? parsed.stack_frames.map(cleanParsedStackFrame).filter(Boolean).slice(0, 16)
    : undefined;

  const signal = {
    schema: 'windbg_crash_signal_v1',
    execution: {
      timedOut: coerceBool(result.timed_out),
      exitCode: coerceInt(result.exit_code)
    },
    target: parsed.target_info || undefined,
    bugcheck: {
      ...analyzeFields.bugcheck,
      code: analyzeFields.bugcheck.code || bugcheckSection.code,
      parameters: analyzeFields.bugcheck.parameters || bugcheckSection.parameters
    },
    crash: analyzeFields.crash,
    blackboxes: analyzeFields.blackboxes,
    process: parsed.process_info,
    stackFrames,
    registers: compactObject(parsed.registers, ['rip', 'rsp', 'rbp', 'rcx', 'rdx', 'r8', 'r9', 'r10']),
    threads: Array.isArray(parsed.threads) ? parsed.threads.slice(0, 8) : undefined,
    notableModules: selectRelevantModules(parsed.modules, analyzeFields.crash, stackFrames, lmvSection),
    debuggerWarnings: selectDebuggerWarnings(result, parsed, sections),
    sectionExcerpts: {
      target: compactText(vertargetSection, 900),
      bugcheck: compactText(bugcheckSectionText, 700),
      thread: compactText(threadSection, 1200),
      irql: compactText(irqlSection, 300)
    },
    rawStdoutOmitted: typeof result.stdout === 'string' && result.stdout.length > 0 ? true : undefined
  };

  const cleaned = removeEmpty(signal) || {};
  return Object.keys(cleaned).length > 1 ? cleaned : {};
}

function extractRelevantWinDbgSignalText(job) {
  const signal = extractRelevantWinDbgSignal(job);
  return Object.keys(signal).length > 0 ? JSON.stringify(signal, null, 2) : '';
}

function extractWinDbgAnalysisPackage(job) {
  const analysisText = extractWinDbgAnalysisText(job);
  const structured = extractRelevantWinDbgSignal(job);
  return {
    analysisText,
    analysisSignalText: Object.keys(structured).length > 0 ? JSON.stringify(structured, null, 2) : '',
    structured
  };
}

function formattedOutputBlock(name, value) {
  const text = typeof value === 'string'
    ? value
    : Array.isArray(value) ? value.join('\n') : '';
  const trimmed = text.trim();
  return trimmed ? `===== ${name} =====\n${trimmed}` : null;
}

function stepSortOrder(key) {
  const match = /^STEP_(\d+)_/.exec(key);
  return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function collectSectionOutputBlocks(sections) {
  if (!sections || typeof sections !== 'object') return [];
  return Object.entries(sections)
    .sort(([a], [b]) => stepSortOrder(a) - stepSortOrder(b) || a.localeCompare(b))
    .map(([name, value]) => formattedOutputBlock(name, value))
    .filter(Boolean);
}

function extractWinDbgAnalysisText(job) {
  const raw = job?.result;

  // A raw string that is not JSON is the cdb text itself — return it verbatim.
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return '';
    if (trimmed[0] !== '{' && trimmed[0] !== '[') return raw;
  }

  const result = coerceResultObject(raw);
  const blocks = [];

  if (typeof result.stdout === 'string' && result.stdout.trim()) {
    blocks.push(result.stdout);
  }

  if (typeof result.stderr === 'string' && result.stderr.trim()) {
    blocks.push(formattedOutputBlock('stderr', result.stderr));
  }

  const sectionKeys = new Set(
    result.sections && typeof result.sections === 'object' && !Array.isArray(result.sections)
      ? Object.keys(result.sections)
      : []
  );
  blocks.push(...collectSectionOutputBlocks(result.sections));

  const topLevelStepBlocks = Object.entries(result)
    .filter(([name]) => /^STEP_\d+_/.test(name) && !sectionKeys.has(name))
    .sort(([a], [b]) => stepSortOrder(a) - stepSortOrder(b) || a.localeCompare(b))
    .map(([name, value]) => formattedOutputBlock(name, value))
    .filter(Boolean);
  blocks.push(...topLevelStepBlocks);

  const output = blocks.filter(Boolean).join('\n\n');
  if (output) return output;

  if (Object.keys(result).length > 0) {
    return JSON.stringify(result, null, 2);
  }

  return '';
}

export {
  DEFAULT_WINDBG_API_BASE_URL,
  extractRelevantWinDbgSignal,
  extractRelevantWinDbgSignalText,
  extractWinDbgAnalysisPackage,
  extractWinDbgAnalysisText,
  getWinDbgJob,
  mapWinDbgJobStatus,
  normalizeWinDbgApiBaseUrl,
  submitWinDbgJob,
  toLegacyWinDbgStatusResponse
};
