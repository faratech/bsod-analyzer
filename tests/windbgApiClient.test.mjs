import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractFullAnalyzeOutput,
  extractRelevantWinDbgSignal,
  extractRelevantWinDbgSignalText,
  extractWinDbgAnalysisText,
  extractWinDbgAnalysisPackage,
  getWinDbgJob,
  isTransientUpstreamStatus,
  mapWinDbgJobStatus,
  normalizeWinDbgApiBaseUrl,
  submitWinDbgJob,
  toLegacyWinDbgStatusResponse,
  WINDBG_JOB_ERROR_GENERIC_MESSAGE,
  WINDBG_JOB_ERROR_MESSAGES,
  winDbgJobErrorLogFields
} from '../shared/windbgApiClient.js';

// A minimal `!analyze -v` body with the fields the extractor cares about.
const ANALYZE_V = [
  'IRQL_NOT_LESS_OR_EQUAL (a)',
  'BUGCHECK_CODE:  a',
  'BUGCHECK_P1: 29c9a2',
  'SYMBOL_NAME:  nt!KiExecuteAllDpcs+8ca',
  'MODULE_NAME: nt',
  'IMAGE_NAME:  ntkrnlmp.exe',
  'FAILURE_BUCKET_ID:  AV_nt!KiExecuteAllDpcs'
].join('\n');

test('WinDBG API base URL normalizes to the new production host', () => {
  assert.equal(normalizeWinDbgApiBaseUrl(), 'https://windbg-api.stack-tech.net');
  assert.equal(normalizeWinDbgApiBaseUrl('https://windbg-api.stack-tech.net/'), 'https://windbg-api.stack-tech.net');
  assert.equal(normalizeWinDbgApiBaseUrl('windbg-api.stack-tech.net'), 'https://windbg-api.stack-tech.net');
  assert.equal(normalizeWinDbgApiBaseUrl('https://windbg-api.stack-tech.net/api/v1'), 'https://windbg-api.stack-tech.net');
});

test('WinDBG submit posts multipart upload to /api/v1/jobs with server-side key header', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ job_id: 'WF-test-123', status: 'queued' }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  const result = await submitWinDbgJob({
    baseUrl: 'https://windbg-api.stack-tech.net/',
    apiKey: 'test-token',
    fileBuffer: Buffer.from('MDMP'),
    fileName: 'mini.dmp',
    fetchImpl
  });

  assert.equal(result.job_id, 'WF-test-123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://windbg-api.stack-tech.net/api/v1/jobs');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['X-API-Key'], 'test-token');
  assert.ok(calls[0].options.body instanceof Blob);
  assert.match(calls[0].options.headers['Content-Type'], /^multipart\/form-data; boundary=----windbg-/);
  assert.ok(Number(calls[0].options.headers['Content-Length']) > Buffer.byteLength('MDMP'));
});

function submitWith(responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const next = responses[Math.min(calls.length, responses.length) - 1];
    if (next instanceof Error) throw next;
    return next();
  };
  const run = () => submitWinDbgJob({
    baseUrl: 'https://windbg-api.stack-tech.net/',
    apiKey: 'test-token',
    fileBuffer: Buffer.from('MDMP'),
    fileName: 'mini.dmp',
    fetchImpl
  });
  return { calls, run };
}

const accepted = () => new Response(JSON.stringify({ job_id: 'WF-retry-123', status: 'queued' }), {
  status: 202,
  headers: { 'Content-Type': 'application/json' }
});
const failing = (status, headers = {}) => () => new Response('<html>upstream</html>', {
  status,
  headers: { 'Content-Type': 'text/html', ...headers }
});
const connectionRefused = () => Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error('connect ECONNREFUSED 203.0.113.7:443'), { code: 'ECONNREFUSED' })
});

test('WinDBG submit retries only failures that guarantee no job was created', async () => {
  for (const first of [failing(429), failing(503, { 'Retry-After': '1' }), connectionRefused()]) {
    const { calls, run } = submitWith([first, accepted]);
    const result = await run();
    assert.equal(result.job_id, 'WF-retry-123');
    assert.equal(calls.length, 2);
    assert.ok(calls[0].options.body instanceof Blob);
    assert.ok(calls[1].options.body instanceof Blob);
    assert.notEqual(calls[0].options.headers['Content-Type'], calls[1].options.headers['Content-Type']);
  }
});

test('WinDBG submit does not retry ambiguous gateway failures (issue #140)', async () => {
  // These can arrive after the origin accepted the upload; with no
  // idempotency key a retry would queue a second job for the same dump.
  for (const status of [502, 503, 504, 520, 522, 524, 530]) {
    const { calls, run } = submitWith([failing(status), accepted]);
    await assert.rejects(run(), error => error?.code === 'WINDBG_UPSTREAM_ERROR' && error?.upstreamStatus === status);
    assert.equal(calls.length, 1, `status ${status} must not be retried`);
  }
  const reset = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
  });
  const { calls, run } = submitWith([reset, accepted]);
  await assert.rejects(run());
  assert.equal(calls.length, 1, 'a reset mid-request is ambiguous too');
});

// Issue #340: a 429 for an exhausted per-key quota (or with a long
// Retry-After) cannot clear before the re-POST, so it is not re-sent.
const tooMany = (body, headers = {}) => () => new Response(
  typeof body === 'string' ? body : JSON.stringify(body),
  { status: 429, headers: { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers } }
);

test('WinDBG submit does not re-POST a 429 that cannot clear within seconds (#340)', async () => {
  const cases = [
    tooMany('Rate limit exceeded for this API key'),
    tooMany({ message: 'Rate limit exceeded for this API key' }),
    tooMany({ message: 'Too many requests', error_code: 'RATE_LIMITED' }),
    tooMany({ message: 'Queue full', code: 'QUEUE_FULL' }, { 'Retry-After': '60' }),
    tooMany('<html>upstream</html>', { 'Retry-After': '120' })
  ];
  for (const first of cases) {
    const { calls, run } = submitWith([first, accepted]);
    await assert.rejects(run(), error => error?.upstreamStatus === 429);
    assert.equal(calls.length, 1);
  }
  const { run } = submitWith([tooMany({ message: 'nope', error_code: 'RATE_LIMITED' })]);
  await assert.rejects(run(), error => error?.upstreamCode === 'RATE_LIMITED');
});

test('WinDBG submit re-POSTs a queue-full 429 and waits its short Retry-After (#340)', async () => {
  for (const first of [tooMany({ message: 'Queue full', code: 'QUEUE_FULL' }), tooMany({ message: 'Queue full' })]) {
    const { calls, run } = submitWith([first, accepted]);
    assert.equal((await run()).job_id, 'WF-retry-123');
    assert.equal(calls.length, 2);
  }
  const { calls, run } = submitWith([tooMany({ message: 'Queue full', error_code: 'QUEUE_FULL' }, { 'Retry-After': '2' }), accepted]);
  const started = Date.now();
  assert.equal((await run()).job_id, 'WF-retry-123');
  assert.equal(calls.length, 2);
  assert.ok(Date.now() - started >= 1900, `waited ${Date.now() - started} ms`);
});

// Issue #335: Cloudflare's 521/523/525/526 mean the request never reached
// WinDbg-API, so a re-POST cannot queue a second job.
test('WinDBG submit retries Cloudflare origin-not-reached statuses once (#335)', async () => {
  for (const status of [521, 523, 525, 526]) {
    const { calls, run } = submitWith([failing(status), accepted]);
    const result = await run();
    assert.equal(result.job_id, 'WF-retry-123', `status ${status}`);
    assert.equal(calls.length, 2, `status ${status}`);
  }
});

test('WinDBG status poll retries every Cloudflare origin-not-reached status (#335)', async () => {
  for (const status of [520, 521, 522, 523, 524, 525, 526]) {
    assert.equal(isTransientUpstreamStatus(status), true, `status ${status}`);
  }
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return calls < 3 ? failing(521)() : new Response(JSON.stringify({ job_id: 'WF-1', status: 'queued' }), { status: 200 });
  };
  const job = await getWinDbgJob({ baseUrl: 'https://x', apiKey: 'k', jobId: 'WF-1', fetchImpl });
  assert.equal(job.job_id, 'WF-1');
  assert.equal(calls, 3);
});

test('WinDBG submit can disable retries for a non-idempotent durable handoff', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response('<html>origin timeout</html>', {
      status: 524,
      headers: { 'Content-Type': 'text/html' }
    });
  };

  await assert.rejects(
    submitWinDbgJob({
      baseUrl: 'https://windbg-api.stack-tech.net/',
      apiKey: 'test-token',
      fileBuffer: Buffer.from('MDMP'),
      fileName: 'mini.dmp',
      maxAttempts: 1,
      fetchImpl
    }),
    error => error?.code === 'WINDBG_UPSTREAM_ERROR' && error?.upstreamStatus === 524
  );
  assert.equal(calls, 1);
});

test('WinDBG job status maps to the legacy browser contract', () => {
  assert.equal(mapWinDbgJobStatus('queued'), 'pending');
  assert.equal(mapWinDbgJobStatus('validating'), 'processing');
  assert.equal(mapWinDbgJobStatus('running'), 'processing');
  assert.equal(mapWinDbgJobStatus('complete'), 'completed');
  assert.equal(mapWinDbgJobStatus('timed_out'), 'failed');

  const response = toLegacyWinDbgStatusResponse({
    status: 'complete',
    submitted_at: '2026-06-19T20:00:00Z',
    started_at: '2026-06-19T20:00:05Z',
    completed_at: '2026-06-19T20:00:15Z'
  }, 'abc12345');

  assert.equal(response.success, true);
  assert.equal(response.data.uid, 'abc12345');
  assert.equal(response.data.status, 'completed');
  assert.equal(response.data.analysis_available, true);
  assert.equal(response.data.processing_time_seconds, 10);
});

test('WinDBG analysis extraction preserves stdout and command sections', () => {
  assert.equal(extractWinDbgAnalysisText({
    result: {
      stdout: 'raw cdb output',
      sections: { analyze: 'section output' }
    }
  }), 'raw cdb output\n\n===== analyze =====\nsection output');

  assert.equal(extractWinDbgAnalysisText({
    result: {
      stdout: 'raw cdb output',
      STEP_10_drivers: 'driver command output',
      STEP_11_vm: ['vm line 1', 'vm line 2']
    }
  }), 'raw cdb output\n\n===== STEP_10_drivers =====\ndriver command output\n\n===== STEP_11_vm =====\nvm line 1\nvm line 2');

  assert.equal(extractWinDbgAnalysisText({
    result: {
      sections: {
        analyze: '!analyze output',
        lm: 'module output'
      }
    }
  }), '===== analyze =====\n!analyze output\n\n===== lm =====\nmodule output');
});

test('WinDBG full analyze output extracts complete !analyze -v section', () => {
  const output = [
    'banner text',
    '',
    '===== STEP_04_analyze_v =====',
    'KMODE_EXCEPTION_NOT_HANDLED (1e)',
    'Arguments:',
    'Arg1: ffffffff`c0000005',
    'STACK_TEXT:',
    'fffff807`12345678 nt!KiDispatchException+0x123',
    '',
    '===== STEP_05_kv =====',
    'stack command output'
  ].join('\n');

  assert.equal(extractFullAnalyzeOutput(output), [
    'KMODE_EXCEPTION_NOT_HANDLED (1e)',
    'Arguments:',
    'Arg1: ffffffff`c0000005',
    'STACK_TEXT:',
    'fffff807`12345678 nt!KiDispatchException+0x123'
  ].join('\n'));
});

test('WinDBG full analyze output falls back to raw Bugcheck Analysis block', () => {
  const output = [
    'setup noise',
    '************* Bugcheck Analysis **************',
    'IRQL_NOT_LESS_OR_EQUAL (a)',
    'BUGCHECK_CODE: a',
    'IMAGE_NAME: ntkrnlmp.exe',
    'quit:',
    'teardown noise'
  ].join('\n');

  assert.equal(extractFullAnalyzeOutput(output), [
    '************* Bugcheck Analysis **************',
    'IRQL_NOT_LESS_OR_EQUAL (a)',
    'BUGCHECK_CODE: a',
    'IMAGE_NAME: ntkrnlmp.exe'
  ].join('\n'));
});

test('WinDBG signal extraction keeps crash facts and omits full stdout noise', () => {
  const noisyStdout = [
    '************* Preparing the environment for Debugger Extensions Gallery repositories **************',
    'ProductVersion:   103.4.3.103947305-official',
    'NatVis script successfully loaded from C:\\Debuggers\\Visualizers\\windows.natvis',
    'IRQL_NOT_LESS_OR_EQUAL (a)',
    'MODULE_NAME: nt',
    'IMAGE_NAME:  ntkrnlmp.exe'
  ].join('\n');

  const job = {
    result: {
      timed_out: false,
      exit_code: 0,
      stdout: noisyStdout,
      sections: {
        STEP_01_vertarget: 'Windows 10 Kernel Version 26100 MP (16 procs) Free x64\nSystem Uptime: 0 days 2:02:06.259',
        STEP_02_bugcheck: 'Bugcheck code 0000000A\nArguments 000000000029c9a2 0000000000000002 0000000000000000 fffff8009fa62f2a',
        STEP_04_analyze_v: [
          'IRQL_NOT_LESS_OR_EQUAL (a)',
          'An attempt was made to access a pageable address at a high IRQL.',
          'BUGCHECK_CODE:  a',
          'BUGCHECK_P1: 29c9a2',
          'BUGCHECK_P2: 2',
          'BUGCHECK_P3: 0',
          'BUGCHECK_P4: fffff8009fa62f2a',
          'PROCESS_NAME:  System',
          'SYMBOL_NAME:  nt!KiExecuteAllDpcs+8ca',
          'MODULE_NAME: nt',
          'IMAGE_NAME:  ntkrnlmp.exe',
          'IMAGE_VERSION:  10.0.26100.4061',
          'FAILURE_BUCKET_ID:  AV_nt!KiExecuteAllDpcs'
        ].join('\n'),
        STEP_09_lmv: [
          'fffff800`9f800000 fffff800`a0800000   nt       (pdb symbols)          c:\\symbols\\ntkrnlmp.pdb',
          '    Loaded symbol image file: ntkrnlmp.exe',
          '    Image path: ntkrnlmp.exe',
          '    Image name: ntkrnlmp.exe',
          '    File version:     10.0.26100.8246',
          '    Product version:  10.0.26100.8246'
        ].join('\n'),
        STEP_14_irql: 'Debugger saved IRQL for processor 0x0 -- 2 (DISPATCH_LEVEL)'
      },
      parsed: {
        target_info: {
          os_version: 'Windows 10 Kernel Version 26100',
          processor_count: 16,
          arch: 'x64',
          system_uptime: '0 days 2:02:06.259'
        },
        stack_frames: [
          {
            sp: 'fffff8003231e760',
            ret_addr: 'fffff8009fb6d956',
            symbol: ': nt!KiExecuteAllDpcs+0x8ca'
          }
        ],
        modules: [
          { name: 'nt', status: 'pdb symbols', pdb_path: 'c:\\symbols\\ntkrnlmp.pdb' },
          { name: 'nvlddmkm', status: 'deferred' },
          { name: 'symcryptk', status: 'deferred' }
        ],
        registers: {
          rip: 'fffff8009fd01c40',
          rsp: 'fffff8003231e488',
          rcx: '000000000000000a'
        },
        errors: ['ERROR: reading list head at 0xfffff800a06fa020']
      }
    }
  };

  const signal = extractRelevantWinDbgSignal(job);
  assert.equal(signal.schema, 'windbg_crash_signal_v1');
  assert.equal(signal.target.os_version, 'Windows 10 Kernel Version 26100');
  assert.equal(signal.bugcheck.code, '0xA');
  assert.deepEqual(signal.bugcheck.parameters, ['29c9a2', '2', '0', 'fffff8009fa62f2a']);
  assert.equal(signal.bugcheck.name, 'IRQL_NOT_LESS_OR_EQUAL');
  assert.equal(signal.crash.failureBucketId, 'AV_nt!KiExecuteAllDpcs');
  assert.equal(signal.crash.imageName, 'ntkrnlmp.exe');
  assert.equal(signal.crash.imageVersion, '10.0.26100.4061');
  assert.equal(signal.stackFrames.length, 1);
  assert.equal(signal.notableModules.find(module => module.name === 'nt')?.details.fileVersion, '10.0.26100.8246');
  assert.ok(signal.notableModules.some(module => module.name === 'nvlddmkm'));

  const signalText = extractRelevantWinDbgSignalText(job);
  assert.match(signalText, /IRQL_NOT_LESS_OR_EQUAL/);
  assert.doesNotMatch(signalText, /Preparing the environment/);
  assert.doesNotMatch(signalText, /103\.4\.3\.103947305/);
});

// ── Robust JSON handling: section resolution across command chains ────────────

test('signal extraction resolves !analyze -v in the USER chain (STEP_02)', () => {
  const signal = extractRelevantWinDbgSignal({
    result: { sections: { STEP_01_vertarget: 'x64', STEP_02_analyze_v: ANALYZE_V } }
  });
  assert.equal(signal.bugcheck.code, '0xA');
  assert.equal(signal.crash.failureBucketId, 'AV_nt!KiExecuteAllDpcs');
  assert.equal(signal.crash.imageName, 'ntkrnlmp.exe');
});

test('signal extraction resolves !analyze -v in the DOTNET chain (STEP_03)', () => {
  const signal = extractRelevantWinDbgSignal({
    result: { sections: { STEP_01_loadby_sos_clr: '', STEP_02_vertarget: 'x64', STEP_03_analyze_v: ANALYZE_V } }
  });
  assert.equal(signal.bugcheck.code, '0xA');
  assert.equal(signal.crash.symbolName, 'nt!KiExecuteAllDpcs+8ca');
});

test('signal extraction tolerates an array-valued section', () => {
  const signal = extractRelevantWinDbgSignal({
    result: { sections: { STEP_04_analyze_v: ANALYZE_V.split('\n') } }
  });
  assert.equal(signal.bugcheck.code, '0xA');
});

test('signal extraction treats top-level STEP outputs as command sections', () => {
  const signal = extractRelevantWinDbgSignal({
    result: {
      STEP_04_analyze_v: ANALYZE_V,
      STEP_14_irql: 'Debugger saved IRQL for processor 0x0 -- 2 (DISPATCH_LEVEL)',
      STEP_20_dpc: 'dpc is not extension gallery command\nNo export dpc found'
    }
  });
  assert.equal(signal.bugcheck.code, '0xA');
  assert.match(signal.sectionExcerpts.irql, /DISPATCH_LEVEL/);
  assert.ok(signal.debuggerWarnings.some(warning => warning.includes('STEP_20_dpc')));
});

// ── Robust JSON handling: every `result` shape ────────────────────────────────

test('result coercion handles object, JSON-string, plain text, array, and null', () => {
  // JSON-encoded string (double-encoded blob)
  const jsonString = extractRelevantWinDbgSignal({
    result: JSON.stringify({ sections: { STEP_04_analyze_v: ANALYZE_V } })
  });
  assert.equal(jsonString.bugcheck.code, '0xA');

  // plain cdb text → used as analyze text
  const plainText = extractRelevantWinDbgSignal({ result: ANALYZE_V });
  assert.equal(plainText.bugcheck.code, '0xA');

  // null / array / number never throw and yield no signal
  assert.deepEqual(extractRelevantWinDbgSignal({ result: null }), {});
  assert.deepEqual(extractRelevantWinDbgSignal({ result: [1, 2, 3] }), {});
  assert.deepEqual(extractRelevantWinDbgSignal({}), {});

  // analysis text falls back across shapes
  assert.equal(extractWinDbgAnalysisText({ result: 'raw text' }), 'raw text');
  assert.equal(extractWinDbgAnalysisText({ result: JSON.stringify({ stdout: 'hi' }) }), 'hi');
  assert.equal(extractWinDbgAnalysisText({ result: null }), '');
});

test('timed_out / exit_code are coerced from strings', () => {
  const signal = extractRelevantWinDbgSignal({
    result: { timed_out: 'true', exit_code: '-1', sections: { STEP_04_analyze_v: ANALYZE_V } }
  });
  assert.equal(signal.execution.timedOut, true);
  assert.equal(signal.execution.exitCode, -1);
});

test('malformed parsed/sections never throw', () => {
  assert.doesNotThrow(() => extractRelevantWinDbgSignal({
    result: { parsed: 'not-an-object', sections: 42, stdout: ANALYZE_V }
  }));
  const signal = extractRelevantWinDbgSignal({
    result: { parsed: 'not-an-object', sections: 42, stdout: ANALYZE_V }
  });
  assert.equal(signal.bugcheck.code, '0xA');
});

// ── Robust JSON handling: server-authoritative ai_signal (Phase 3) ────────────

test('server-provided ai_signal is preferred over local extraction', () => {
  const signal = extractRelevantWinDbgSignal({
    result: {
      ai_signal: { schema: 'windbg_crash_signal_v1', bugcheck: { code: '0xDEAD' } },
      sections: { STEP_04_analyze_v: ANALYZE_V }   // would yield 0xA locally
    }
  });
  assert.equal(signal.bugcheck.code, '0xDEAD');
});

test('malformed ai_signal falls back to local extraction', () => {
  const signal = extractRelevantWinDbgSignal({
    result: {
      ai_signal: { schema: 'something_else', junk: true },
      sections: { STEP_04_analyze_v: ANALYZE_V }
    }
  });
  assert.equal(signal.bugcheck.code, '0xA');
});

test('analysis package passes through a valid server signal', () => {
  const pkg = extractWinDbgAnalysisPackage({
    result: {
      stdout: 'raw',
      ai_signal: { schema: 'windbg_crash_signal_v1', bugcheck: { code: '0xBEEF' } }
    }
  });
  assert.equal(pkg.structured.bugcheck.code, '0xBEEF');
  assert.match(pkg.analysisSignalText, /0xBEEF/);
  assert.equal(pkg.analysisText, 'raw');
});

// ── Robust JSON handling: status + error surfacing ────────────────────────────

test('unknown upstream status maps to pending but exposes raw_status', () => {
  assert.equal(mapWinDbgJobStatus('some_new_state'), 'pending');
  const res = toLegacyWinDbgStatusResponse({ status: 'some_new_state' }, 'abc12345');
  assert.equal(res.data.status, 'pending');
  assert.equal(res.data.raw_status, 'some_new_state');
});

test('cancelled status maps to failed and surfaces a fixed message + category', () => {
  assert.equal(mapWinDbgJobStatus('cancelled'), 'failed');
  const res = toLegacyWinDbgStatusResponse(
    { status: 'failed', error: 'cdb.exe exited with code 1', error_category: 'cdb' },
    'abc12345'
  );
  assert.equal(res.data.status, 'failed');
  assert.equal(res.data.error_message, WINDBG_JOB_ERROR_MESSAGES.cdb);
  assert.equal(res.data.error_category, 'cdb');
});

test('failed job status never forwards the raw upstream job.error text (#293)', () => {
  const raw = 'C:\\symbols\\ntkrnlmp.pdb\\ABC\\ntkrnlmp.pdb: E_FAIL loading D:\\WinDbgApi\\ext\\foo.dll';
  for (const category of ['cdb', 'storage', 'worker', 'timeout', 'upload', 'watchdog', 'something_new', undefined]) {
    const res = toLegacyWinDbgStatusResponse(
      { status: 'failed', error: raw, error_category: category },
      'abc12345'
    );
    const body = JSON.stringify(res);
    assert.ok(!body.includes('ntkrnlmp'), `raw error leaked for category ${category}`);
    assert.ok(!body.includes('WinDbgApi'), `raw error leaked for category ${category}`);
    assert.equal(typeof res.data.error_message, 'string');
    assert.ok(res.data.error_message.length > 0);
    assert.equal(res.data.error_category, category);
  }
  assert.equal(
    toLegacyWinDbgStatusResponse({ status: 'failed', error: raw, error_category: 'storage' }, 'abc12345').data.error_message,
    WINDBG_JOB_ERROR_MESSAGES.storage
  );
  assert.equal(
    toLegacyWinDbgStatusResponse({ status: 'failed', error: raw, error_category: 'nope' }, 'abc12345').data.error_message,
    WINDBG_JOB_ERROR_GENERIC_MESSAGE
  );
  // A failed job with no upstream error text still gets the fixed message;
  // a running job without an error carries none.
  assert.equal(
    toLegacyWinDbgStatusResponse({ status: 'timed_out', error_category: 'timeout' }, 'abc12345').data.error_message,
    WINDBG_JOB_ERROR_MESSAGES.timeout
  );
  assert.equal(toLegacyWinDbgStatusResponse({ status: 'running' }, 'abc12345').data.error_message, undefined);
});

test('winDbgJobErrorLogFields bounds the raw upstream job error for server logs', () => {
  const fields = winDbgJobErrorLogFields({ id: 'job-1', status: 'failed', error: 'x'.repeat(5000), error_category: 'cdb' });
  assert.equal(fields.jobId, 'job-1');
  assert.equal(fields.errorCategory, 'cdb');
  assert.equal(fields.error.length, 500);
  assert.equal(winDbgJobErrorLogFields({ status: 'complete' }), null);
});

test('local signal keeps only the kv call site and selects module+offset stack modules', () => {
  const signal = extractRelevantWinDbgSignal({
    result: {
      sections: { STEP_03_analyze_v: ANALYZE_V },
      parsed: {
        stack_frames: [
          { sp: 'ffff8a0c`5c2f6f48', ret_addr: 'fffff803`63a2b5a9', symbol: ': 00000000`0000000a 00000000`00000010 00000000`00000002 00000000`00000000 : nt!KeBugCheckEx' },
          { sp: 'ffff8a0c`5c2f7090', ret_addr: 'fffff803`6b1a1234', symbol: ': 00000000`00000000 00000000`00000000 00000000`00000000 00000000`00000000 : xyzfilt+0x1a1234' }
        ],
        modules: [
          { name: 'nt', status: 'pdb symbols' },
          { name: 'xyzfilt', status: 'deferred' },
          { name: 'unrelated', status: 'deferred' }
        ]
      }
    }
  });
  assert.deepEqual(signal.stackFrames.map(frame => frame.symbol), ['nt!KeBugCheckEx', 'xyzfilt+0x1a1234']);
  assert.ok(signal.notableModules.some(module => module.name === 'xyzfilt'));
  assert.ok(!signal.notableModules.some(module => module.name === 'unrelated'));
});

test('server ai_signal kv-style stack frames are normalised to the call site', () => {
  const signal = extractRelevantWinDbgSignal({
    result: {
      ai_signal: {
        schema: 'windbg_crash_signal_v1',
        bugcheck: { code: '0xD1' },
        stackFrames: [
          { sp: 'ffff8a0c`5c2f6f50', ret_addr: 'fffff803`63a26f83', symbol: ': ffffcb00`00000000 00000000`00000000 00000000`00000000 00000000`00000000 : nt!KiBugCheckDispatch+0x69' }
        ]
      }
    }
  });
  assert.deepEqual(signal.stackFrames, [
    { sp: 'ffff8a0c`5c2f6f50', ret_addr: 'fffff803`63a26f83', symbol: 'nt!KiBugCheckDispatch+0x69' }
  ]);
});

test('server ai_signal is merged over the local extraction so client-only keys survive', async () => {
  const { readFile } = await import('node:fs/promises');
  // Real WinDbg-API job result (C# CrashSignalBuilder ai_signal + sections + parsed).
  const result = JSON.parse(await readFile(new URL('./fixtures/windbgJobResultD1.json', import.meta.url), 'utf8'));
  result.sections.STEP_03_analyze_v += [
    '',
    'STACK_COMMAND:  .cxr; .ecxr ; kb',
    '',
    'FAILURE_ID_HASH:  {9a3c1f2e-0000-4d2b-8c6a-1234567890ab}',
    '',
    '    Key  : Analysis.CPU.mSec',
    '    Value: 1234'
  ].join('\n');
  result.ai_signal.bugcheck.name = 'SERVER_NAME_WINS';
  result.ai_signal.crash.processName = 'ServerProcess';

  const signal = extractRelevantWinDbgSignal({ result });

  // Server values win where both sides have them.
  assert.equal(signal.bugcheck.code, '0xD1');
  assert.equal(signal.bugcheck.name, 'SERVER_NAME_WINS');
  assert.deepEqual(signal.bugcheck.parameters, ['10', '2', '0', 'fffff8036b1a1234']);
  assert.equal(signal.crash.processName, 'ServerProcess');
  assert.equal(signal.crash.failureBucketId, 'AV_nvlddmkm!unknown_function');
  assert.equal(signal.stackFrames.length, 3);
  assert.equal(signal.target.os_version, 'Windows 10 Kernel Version 22621');

  // Keys the server signal omits come from the local extraction.
  assert.match(signal.bugcheck.description, /pageable \(or completely invalid\) address/);
  assert.deepEqual(signal.bugcheck.keyValues, { 'Analysis.CPU.mSec': '1234' });
  assert.equal(signal.crash.readAddress, '0000000000000010');
  assert.equal(signal.crash.stackCommand, '.cxr; .ecxr ; kb');
  assert.equal(signal.crash.failureHash, '{9a3c1f2e-0000-4d2b-8c6a-1234567890ab}');
  assert.deepEqual(signal.blackboxes, ['BLACKBOXNTFS']);
  const nvlddmkm = signal.notableModules.find(module => module.name === 'nvlddmkm');
  assert.equal(nvlddmkm?.details?.fileVersion, '31.0.15.5222');

  const pkg = extractWinDbgAnalysisPackage({ result });
  assert.match(pkg.analysisSignalText, /notableModules/);
});
