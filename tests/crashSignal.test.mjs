import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCrashSignalPayload,
  createCrashSignalRecorder,
  enrichWithWinDbgEvidence
} from '../server/crashSignal.js';

const HASH = '0123456789abcdef';
const AI_REPORT = {
  summary: 'The display driver stopped responding.',
  probableCause: 'A GPU timeout detection and recovery failure.',
  culprit: 'nvlddmkm.sys',
  recommendations: ['Update the NVIDIA driver']
};
const STRUCTURED = {
  schema: 'windbg_crash_signal_v1',
  bugcheck: { code: '0x116', name: 'VIDEO_TDR_FAILURE', parameters: ['ffffe001`12345678'] },
  crash: { imageName: 'nvlddmkm.sys', moduleName: 'nvlddmkm' },
  target: { os_version: 'Windows 11 24H2 (26100.2033)' }
};
const SIGNAL_TEXT = JSON.stringify(STRUCTURED, null, 2);
const EVIDENCE = {
  analysisText: 'BUGCHECK_CODE:  116\nIMAGE_NAME:  nvlddmkm.sys\n',
  analysisSignalText: SIGNAL_TEXT,
  structured: STRUCTURED
};
const PROMPT = `prefix\n\`\`\`json\n${SIGNAL_TEXT}\n\`\`\``;

// url/key keep an explicit undefined (an unset env var) instead of defaulting.
function harness({ respond, timeoutMs, ...config } = {}) {
  const calls = [];
  const warnings = [];
  const recorder = createCrashSignalRecorder({
    url: 'url' in config ? config.url : 'https://forum.example/api/',
    key: 'key' in config ? config.key : 'k',
    timeoutMs,
    fetchImpl: async (endpoint, init) => {
      calls.push({ endpoint, init, body: JSON.parse(init.body) });
      return respond ? respond(init) : { ok: true, status: 200 };
    },
    logger: { warn: (event, fields) => warnings.push([event, fields]) }
  });
  return { recorder, calls, warnings };
}

test('buildCrashSignalPayload maps the final report', () => {
  const payload = buildCrashSignalPayload({
    ...AI_REPORT,
    summary: 's'.repeat(2500),
    bugCheck: { code: '0x116', name: 'VIDEO_TDR_FAILURE' },
    systemInfo: { windowsVersion: '10.0.26100' }
  }, 'a'.repeat(80));
  assert.deepEqual(payload, {
    file_hash: 'a'.repeat(64),
    bug_check_code: '0x116',
    bug_check_name: 'VIDEO_TDR_FAILURE',
    faulty_driver: 'nvlddmkm.sys',
    windows_version: '10.0.26100',
    crash_time: null,
    parse_confidence: 83,
    raw_excerpt: 's'.repeat(2000)
  });
});

test('buildCrashSignalPayload falls back to the crash location and rejects missing inputs', () => {
  const payload = buildCrashSignalPayload({ summary: 42, crashLocation: { module: 'tcpip.sys' } }, HASH);
  assert.equal(payload.faulty_driver, 'tcpip.sys');
  assert.equal(payload.bug_check_code, null);
  assert.equal(payload.windows_version, null);
  assert.equal(payload.raw_excerpt, '');
  assert.equal(payload.parse_confidence, 17);
  assert.equal(buildCrashSignalPayload(null, HASH), null);
  assert.equal(buildCrashSignalPayload(AI_REPORT, ''), null);
  assert.equal(buildCrashSignalPayload(AI_REPORT, undefined), null);
});

test('recorder is a no-op unless both URL and key are set', async () => {
  for (const opts of [{ url: '' }, { key: '' }, { url: undefined, key: undefined }]) {
    const { recorder, calls } = harness(opts);
    assert.equal(recorder.enabled, false);
    await recorder.record(AI_REPORT, HASH);
    let loaded = false;
    await recorder.recordWebAnalysis({ fileHash: HASH, promptText: PROMPT, aiReport: AI_REPORT, loadEvidence: async () => { loaded = true; return EVIDENCE; } });
    assert.equal(calls.length, 0);
    assert.equal(loaded, false);
  }
});

test('record POSTs the payload to <url>/crash-signal with the API key', async () => {
  const { recorder, calls, warnings } = harness({ url: 'https://forum.example/api//', key: 'secret' });
  assert.equal(recorder.enabled, true);
  await recorder.record(AI_REPORT, HASH);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, 'https://forum.example/api/crash-signal');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['X-API-Key'], 'secret');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].body.file_hash, HASH);
  assert.equal(calls[0].body.raw_excerpt, AI_REPORT.summary);
  assert.deepEqual(warnings, []);

  await recorder.record(null, HASH);
  assert.equal(calls.length, 1, 'no payload, no request');
});

test('record never rejects: HTTP errors, fetch failures and throws only warn', async () => {
  const cases = [
    [() => ({ ok: false, status: 503 }), 'crash_signal.http'],
    [() => Promise.reject(new Error('ECONNRESET')), 'crash_signal.failed'],
    [() => { throw new Error('boom'); }, 'crash_signal.failed']
  ];
  for (const [respond, event] of cases) {
    const { recorder, warnings } = harness({ respond });
    await recorder.record(AI_REPORT, HASH);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], event);
  }
});

test('record aborts a slow ingest after the timeout', async () => {
  const { recorder, warnings } = harness({
    timeoutMs: 10,
    respond: init => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    })
  });
  await recorder.record(AI_REPORT, HASH);
  assert.deepEqual(warnings, [['crash_signal.failed', { error: 'aborted' }]]);
});

test('enrichWithWinDbgEvidence overlays WinDBG fields on the AI report', () => {
  const report = enrichWithWinDbgEvidence({ ...AI_REPORT, bugCheck: { code: '0xA', name: 'WRONG' } }, EVIDENCE);
  assert.equal(report.bugCheck.code, '0x116');
  assert.equal(report.bugCheck.name, 'VIDEO_TDR_FAILURE');
  assert.equal(report.systemInfo.windowsVersion, 'Windows 11 24H2 (26100.2033)');
  assert.equal(report.culprit, 'nvlddmkm.sys');
  assert.equal(report.summary, AI_REPORT.summary);
});

test('recordWebAnalysis records the AI report merged with upstream WinDBG evidence', async () => {
  const { recorder, calls } = harness();
  await recorder.recordWebAnalysis({ fileHash: HASH, promptText: PROMPT, aiReport: AI_REPORT, loadEvidence: async () => EVIDENCE });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.file_hash, HASH);
  assert.equal(calls[0].body.bug_check_code, '0x116');
  assert.equal(calls[0].body.bug_check_name, 'VIDEO_TDR_FAILURE');
  assert.equal(calls[0].body.windows_version, 'Windows 11 24H2 (26100.2033)');
  assert.equal(calls[0].body.faulty_driver, 'nvlddmkm.sys');
  assert.equal(calls[0].body.raw_excerpt, AI_REPORT.summary);
});

test('recordWebAnalysis skips without an owned hash, a report, or WinDBG evidence', async () => {
  const { recorder, calls, warnings } = harness();
  let loads = 0;
  const loadEvidence = async () => { loads += 1; return EVIDENCE; };
  await recorder.recordWebAnalysis({ fileHash: undefined, promptText: PROMPT, aiReport: AI_REPORT, loadEvidence });
  await recorder.recordWebAnalysis({ fileHash: HASH, promptText: PROMPT, aiReport: null, loadEvidence });
  assert.equal(loads, 0);

  await recorder.recordWebAnalysis({ fileHash: HASH, promptText: PROMPT, aiReport: AI_REPORT, loadEvidence: async () => ({ analysisText: '', structured: {} }) });
  await recorder.recordWebAnalysis({ fileHash: HASH, promptText: PROMPT, aiReport: AI_REPORT, loadEvidence: async () => { throw new Error('WinDBG down'); } });
  assert.equal(calls.length, 0);
  assert.deepEqual(warnings, [
    ['crash_signal.web_skipped', { reason: 'no_windbg_evidence' }],
    ['crash_signal.web_failed', { error: 'WinDBG down' }]
  ]);
});

test('recordWebAnalysis skips a prompt that did not carry the upstream evidence', async () => {
  const { recorder, calls, warnings } = harness();
  const forged = PROMPT.replace('0x116', '0x50');
  await recorder.recordWebAnalysis({ fileHash: HASH, promptText: forged, aiReport: AI_REPORT, loadEvidence: async () => EVIDENCE });
  assert.equal(calls.length, 0);
  assert.deepEqual(warnings, [['crash_signal.web_skipped', { reason: 'evidence_mismatch' }]]);

  // Raw-excerpt prompts (no structured signal) have nothing to compare against.
  await recorder.recordWebAnalysis({
    fileHash: HASH,
    promptText: 'raw excerpt prompt',
    aiReport: AI_REPORT,
    loadEvidence: async () => ({ ...EVIDENCE, analysisSignalText: '' })
  });
  assert.equal(calls.length, 1);
});
