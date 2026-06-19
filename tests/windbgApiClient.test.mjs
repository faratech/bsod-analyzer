import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractWinDbgAnalysisText,
  mapWinDbgJobStatus,
  normalizeWinDbgApiBaseUrl,
  submitWinDbgJob,
  toLegacyWinDbgStatusResponse
} from '../shared/windbgApiClient.js';

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

test('WinDBG analysis extraction prefers stdout and falls back to sections', () => {
  assert.equal(extractWinDbgAnalysisText({
    result: {
      stdout: 'raw cdb output',
      sections: { analyze: 'section output' }
    }
  }), 'raw cdb output');

  assert.equal(extractWinDbgAnalysisText({
    result: {
      sections: {
        analyze: '!analyze output',
        lm: 'module output'
      }
    }
  }), '===== analyze =====\n!analyze output\n\n===== lm =====\nmodule output');
});
