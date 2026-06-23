import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractRelevantWinDbgSignal,
  extractRelevantWinDbgSignalText,
  extractWinDbgAnalysisText,
  extractWinDbgAnalysisPackage,
  mapWinDbgJobStatus,
  normalizeWinDbgApiBaseUrl,
  submitWinDbgJob,
  toLegacyWinDbgStatusResponse
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
  assert.ok(calls[0].options.body instanceof FormData);
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

test('cancelled status maps to failed and surfaces error + category', () => {
  assert.equal(mapWinDbgJobStatus('cancelled'), 'failed');
  const res = toLegacyWinDbgStatusResponse(
    { status: 'failed', error: 'cdb.exe exited with code 1', error_category: 'cdb' },
    'abc12345'
  );
  assert.equal(res.data.status, 'failed');
  assert.equal(res.data.error_message, 'cdb.exe exited with code 1');
  assert.equal(res.data.error_category, 'cdb');
});
