import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ROW_BYTES,
  buildAiReportRow,
  buildCorpusRow,
  createWinDbgCorpusRecorder,
  toAiInsertAllRow,
  toInsertAllRow
} from '../server/windbgCorpus.js';

const result = {
  timed_out: false,
  exit_code: 0,
  stdout: 'Loaded symbol image file: ntoskrnl.exe\nC:\\Users\\danie\\AppData\\x.sys',
  stderr: '',
  sections: { STEP_01_vertarget: 'Windows 10 Kernel Version 26100' },
  parsed: { modules: [{ name: 'nt' }] },
  ai_signal: {
    schema: 'windbg_crash_signal_v1',
    bugcheck: { name: 'WINLOGON_FATAL_ERROR', code: '0xC000021A', parameters: ['1', '2'] },
    crash: {
      failureBucketId: '0xc000021a_nt!Foo',
      symbolName: 'nt!Foo+895',
      moduleName: 'nt',
      imageName: 'ntkrnlmp.exe',
      imageVersion: '10.0.26100.8246',
      processName: 'smss.exe'
    },
    target: { os_version: 'Windows 10 Kernel Version 26100', arch: 'x64' }
  }
};

const job = {
  id: 'job-1',
  status: 'complete',
  mode: 'dump',
  dump_type: 'kernel',
  canonical_type: 'kernel-mini',
  detected_profile: 'kernel-mini',
  variant_key: 'kernel-mini',
  submitted_at: '2026-09-25T20:00:00Z',
  started_at: '2026-09-25T20:00:01Z',
  completed_at: '2026-09-25T20:01:00Z',
  error: null,
  error_category: null,
  result
};

function fakeFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift() ?? { status: 200, body: {} };
    return { ok: next.status < 400, status: next.status, json: async () => next.body };
  };
  return { calls, fetchImpl };
}

test('buildCorpusRow keeps the complete, unredacted result and extracts query columns', () => {
  const row = buildCorpusRow(job, { fileHash: 'abc', fileSizeBytes: 2048, now: Date.parse('2026-09-26T00:00:00Z') });
  assert.equal(row.job_id, 'job-1');
  assert.equal(row.ingest_source, 'live');
  assert.equal(row.ingested_at, '2026-09-26T00:00:00.000Z');
  assert.equal(row.file_hash, 'abc');
  assert.equal(row.file_size_bytes, 2048);
  assert.equal(row.completed_at, '2026-09-25T20:01:00.000Z');
  assert.equal(row.bugcheck_code, '0xC000021A');
  assert.equal(row.bugcheck_name, 'WINLOGON_FATAL_ERROR');
  assert.equal(row.failure_bucket, '0xc000021a_nt!Foo');
  assert.equal(row.image_name, 'ntkrnlmp.exe');
  assert.equal(row.image_version, '10.0.26100.8246');
  assert.equal(row.process_name, 'smss.exe');
  assert.equal(row.arch, 'x64');
  assert.equal(row.raw_output_pruned, false);
  assert.deepEqual(row.result, result);
  assert.match(row.result.stdout, /Users\\danie/);
});

test('buildCorpusRow accepts a JSON-string result and tolerates a missing signal', () => {
  const row = buildCorpusRow({ ...job, result: JSON.stringify({ stdout: 'x' }) });
  assert.deepEqual(row.result, { stdout: 'x' });
  assert.equal(row.bugcheck_code, null);
  assert.equal(row.file_size_bytes, null);
});

test('toInsertAllRow sends the JSON column as a JSON string', () => {
  const row = toInsertAllRow(buildCorpusRow(job));
  assert.equal(typeof row.result, 'string');
  assert.deepEqual(JSON.parse(row.result), result);
});

test('toInsertAllRow drops only stdout when a row would exceed the insertAll limit', () => {
  const huge = { ...result, stdout: 'x'.repeat(MAX_ROW_BYTES + 10) };
  const row = toInsertAllRow(buildCorpusRow({ ...job, result: huge }));
  const parsed = JSON.parse(row.result);
  assert.equal(parsed.stdout, null);
  assert.equal(parsed.stdout_omitted_for_size, true);
  assert.deepEqual(parsed.sections, result.sections);
});

test('record inserts with the job id as insertId, then acknowledges the job', async () => {
  const { calls, fetchImpl } = fakeFetch([{ status: 200, body: {} }]);
  const acked = [];
  const recorder = createWinDbgCorpusRecorder({
    projectId: 'proj',
    getAccessToken: async () => 'tok',
    fetchImpl,
    markArchived: async ids => { acked.push(...ids); }
  });
  assert.equal(await recorder.record(job, { fileHash: 'abc' }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://bigquery.googleapis.com/bigquery/v2/projects/proj/datasets/bsod_corpus/tables/windbg_analyses/insertAll');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.rows[0].insertId, 'job-1');
  assert.equal(body.rows[0].json.file_hash, 'abc');
  assert.deepEqual(acked, ['job-1']);

  // A repeat download of the same job is not inserted again.
  assert.equal(await recorder.record(job), false);
  assert.equal(calls.length, 1);
});

test('record never acknowledges a job BigQuery did not store', async () => {
  const warnings = [];
  const logger = { warn: (event, fields) => warnings.push({ event, fields }) };
  const acked = [];
  const { fetchImpl } = fakeFetch([
    { status: 200, body: { insertErrors: [{ index: 0, errors: [{ location: 'result', message: 'bad' }] }] } },
    { status: 500, body: { error: { message: 'backend error' } } }
  ]);
  const recorder = createWinDbgCorpusRecorder({
    projectId: 'proj',
    getAccessToken: async () => 'tok',
    fetchImpl,
    markArchived: async ids => { acked.push(...ids); },
    logger
  });
  assert.equal(await recorder.record(job), false);
  assert.equal(await recorder.record(job), false);
  assert.deepEqual(acked, []);
  assert.deepEqual(warnings.map(w => w.event), ['corpus.insert_failed', 'corpus.insert_failed']);
  assert.match(warnings[0].fields.error, /result bad/);
});

test('an acknowledgement failure is logged but the row still counts as stored', async () => {
  const warnings = [];
  const recorder = createWinDbgCorpusRecorder({
    projectId: 'proj',
    getAccessToken: async () => 'tok',
    fetchImpl: fakeFetch([{ status: 200, body: {} }]).fetchImpl,
    markArchived: async () => { throw new Error('404 not found'); },
    logger: { warn: event => warnings.push(event) }
  });
  assert.equal(await recorder.record(job), true);
  assert.deepEqual(warnings, ['corpus.ack_failed']);
});

test('record skips unfinished jobs and respects isEnabled', async () => {
  const { calls, fetchImpl } = fakeFetch([]);
  const recorder = createWinDbgCorpusRecorder({ projectId: 'p', getAccessToken: async () => 't', fetchImpl });
  assert.equal(await recorder.record({ ...job, status: 'running' }), false);
  const disabled = createWinDbgCorpusRecorder({
    projectId: 'p', getAccessToken: async () => 't', fetchImpl, isEnabled: () => false
  });
  assert.equal(await disabled.record(job), false);
  assert.equal(calls.length, 0);
});

test('dataset and table names are restricted to plain identifiers', () => {
  assert.throws(() => createWinDbgCorpusRecorder({ dataset: 'a.b' }), TypeError);
});

const aiEntry = {
  origin: 'api',
  source: 'windbg',
  promptType: 'windbg',
  jobId: 'job-1',
  fileHash: 'abc',
  provider: 'deepseek',
  model: 'gpt-6-luna',
  modelVersion: 'gpt-6-luna-2026-09-01',
  serviceTier: 'incentivized-tier',
  route: 'openai:gpt-6-luna',
  promptText: 'prompt with evidence',
  responseText: '{"summary":"s"}',
  report: { summary: 's', culprit: 'foo.sys' },
  finalReport: { summary: 's', culprit: 'foo.sys', bugCheck: { code: '0x9F' } },
  usage: { promptTokenCount: 100, candidatesTokenCount: 20 }
};

test('buildAiReportRow keeps prompt, response, reports and usage joinable by job_id/file_hash', () => {
  const row = buildAiReportRow(aiEntry, { now: Date.parse('2026-09-26T00:00:00Z'), reportId: 'r1' });
  assert.equal(row.report_id, 'r1');
  assert.equal(row.created_at, '2026-09-26T00:00:00.000Z');
  assert.equal(row.job_id, 'job-1');
  assert.equal(row.file_hash, 'abc');
  assert.equal(row.model, 'gpt-6-luna');
  assert.equal(row.model_version, 'gpt-6-luna-2026-09-01');
  assert.equal(row.service_tier, 'incentivized-tier');
  assert.equal(row.route, 'openai:gpt-6-luna');
  assert.equal(row.prompt_text, 'prompt with evidence');
  assert.deepEqual(row.final_report.bugCheck, { code: '0x9F' });
  assert.equal(buildAiReportRow({ ...aiEntry, report: '{"a":1}' }).report.a, 1);
  assert.deepEqual(buildAiReportRow({ ...aiEntry, promptText: [{ text: 'x' }] }).prompt_text, '[{"text":"x"}]');
});

test('toAiInsertAllRow stringifies JSON columns and drops only an oversized prompt', () => {
  const row = toAiInsertAllRow(buildAiReportRow(aiEntry, { reportId: 'r1' }));
  assert.deepEqual(JSON.parse(row.report), aiEntry.report);
  assert.deepEqual(JSON.parse(row.usage), aiEntry.usage);
  const huge = toAiInsertAllRow(buildAiReportRow({ ...aiEntry, promptText: 'p'.repeat(MAX_ROW_BYTES + 1) }, { reportId: 'r2' }));
  assert.equal(huge.prompt_text, null);
  assert.equal(huge.prompt_omitted_for_size, true);
  assert.deepEqual(JSON.parse(huge.report), aiEntry.report);
});

test('recordAiReport inserts into ai_reports keyed by a fresh report id', async () => {
  const { calls, fetchImpl } = fakeFetch([{ status: 200, body: {} }]);
  const recorder = createWinDbgCorpusRecorder({ projectId: 'proj', getAccessToken: async () => 'tok', fetchImpl });
  assert.equal(await recorder.recordAiReport(aiEntry), true);
  assert.equal(calls[0].url, 'https://bigquery.googleapis.com/bigquery/v2/projects/proj/datasets/bsod_corpus/tables/ai_reports/insertAll');
  const body = JSON.parse(calls[0].init.body);
  assert.match(body.rows[0].insertId, /^[0-9a-f-]{36}$/);
  assert.equal(body.rows[0].json.job_id, 'job-1');
  assert.equal(typeof body.rows[0].json.report, 'string');
});

test('recordAiReport logs and returns false on failure, and skips when disabled or empty', async () => {
  const warnings = [];
  const failing = createWinDbgCorpusRecorder({
    projectId: 'p', getAccessToken: async () => 't',
    fetchImpl: fakeFetch([{ status: 500, body: { error: { message: 'down' } } }]).fetchImpl,
    logger: { warn: event => warnings.push(event) }
  });
  assert.equal(await failing.recordAiReport(aiEntry), false);
  assert.deepEqual(warnings, ['corpus.ai_insert_failed']);
  const { calls, fetchImpl } = fakeFetch([]);
  const disabled = createWinDbgCorpusRecorder({ projectId: 'p', getAccessToken: async () => 't', fetchImpl, isEnabled: () => false });
  assert.equal(await disabled.recordAiReport(aiEntry), false);
  const enabled = createWinDbgCorpusRecorder({ projectId: 'p', getAccessToken: async () => 't', fetchImpl });
  assert.equal(await enabled.recordAiReport({ ...aiEntry, report: null }), false);
  assert.equal(calls.length, 0);
});

test('rows record the data-use terms version they were collected under', () => {
  assert.equal(buildCorpusRow(job, { dataUseTerms: '2026-09' }).data_use_terms, '2026-09');
  assert.equal(buildCorpusRow(job).data_use_terms, null);
  assert.equal(buildAiReportRow({ report: { a: 1 }, dataUseTerms: 'api-2026-09' }, { reportId: 'r' }).data_use_terms, 'api-2026-09');
});
