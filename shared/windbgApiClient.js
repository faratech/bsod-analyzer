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
    if (typeof value !== 'string') continue;
    for (const line of value.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && warningPattern.test(trimmed)) {
        warnings.add(`${name}: ${compactText(trimmed, 260)}`);
        if (warnings.size >= 25) return [...warnings];
      }
    }
  }
  return warnings.size > 0 ? [...warnings] : undefined;
}

function getResultObject(job) {
  const result = job?.result;
  if (result && typeof result === 'object') return result;
  if (typeof result === 'string' && result.trim()) return { stdout: result };
  return {};
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
  const parsed = result.parsed && typeof result.parsed === 'object' ? result.parsed : {};
  const sections = result.sections && typeof result.sections === 'object' ? result.sections : {};
  const analyzeText = sections.STEP_04_analyze_v || result.stdout || '';
  const analyzeFields = parseAnalyzeFields(analyzeText);
  const bugcheckSection = parseBugCheckSection(sections.STEP_02_bugcheck);
  const stackFrames = Array.isArray(parsed.stack_frames)
    ? parsed.stack_frames.map(cleanParsedStackFrame).filter(Boolean).slice(0, 16)
    : undefined;

  const signal = {
    schema: 'windbg_crash_signal_v1',
    execution: {
      timedOut: result.timed_out,
      exitCode: result.exit_code
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
    notableModules: selectRelevantModules(parsed.modules, analyzeFields.crash, stackFrames, sections.STEP_09_lmv),
    debuggerWarnings: selectDebuggerWarnings(result, parsed, sections),
    sectionExcerpts: {
      target: compactText(sections.STEP_01_vertarget, 900),
      bugcheck: compactText(sections.STEP_02_bugcheck, 700),
      thread: compactText(sections.STEP_06_thread, 1200),
      irql: compactText(sections.STEP_14_irql, 300)
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
