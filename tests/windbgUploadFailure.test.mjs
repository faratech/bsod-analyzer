import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { winDbgUpstreamFailureCode, winDbgUpstreamHttpStatus, windbgUploadFailureResponse } from '../server/windbgUploadFailure.js';
import { classifyWinDbgSubmitFailure, isUnconfirmedSubmitFailure } from '../server/windbgSubmitFailure.js';
import { analyzeSubmitFailureResponse } from '../server/externalJobs.js';

// Issue #325: the upload route answered every WinDbg-API failure as a
// code-less 502, which the browser retries as transient, so a dump the
// upstream permanently refused was uploaded three times.
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));

function upstreamError(status, extra = {}) {
  return Object.assign(new Error(`WinDBG submit failed with status ${status}: nope`), {
    code: 'WINDBG_UPSTREAM_ERROR', upstreamStatus: status, retryAfter: null, ...extra
  });
}

test('an upstream refusal of the file is a non-retryable 422 WINDBG_UPLOAD_REJECTED (#325, #327)', () => {
  for (const status of [400, 413, 415, 422]) {
    const { status: http, body } = windbgUploadFailureResponse(upstreamError(status));
    assert.equal(http, 422, `upstream ${status}`);
    assert.equal(body.success, false);
    assert.equal(body.code, 'WINDBG_UPLOAD_REJECTED');
    assert.equal(body.retryable, false);
    assert.match(body.error, /rejected/i);
    assert.doesNotMatch(body.error, /nope/, 'upstream text is not echoed');
  }
});

// Issue #327: "try again later" statuses were answered as a rejected dump
// (408/409/423/425) or a non-retryable failure (507, storage pressure).
const BLAMES_FILE = /rejected|supported Windows crash dump|not a (valid|supported)|invalid (file|dump)/i;

test('try-again-later upstream statuses are a retryable 503 with a 15-30 s Retry-After that does not blame the file (#327)', () => {
  const cases = [
    upstreamError(408), upstreamError(409), upstreamError(423), upstreamError(425),
    upstreamError(429), upstreamError(507), upstreamError(503, { retryAfter: '5' })
  ];
  for (const error of cases) {
    const { status: http, body, headers } = windbgUploadFailureResponse(error);
    assert.equal(http, 503, `upstream ${error.upstreamStatus}`);
    assert.equal(body.code, 'WINDBG_UPLOAD_RETRY_LATER');
    assert.equal(body.retryable, true);
    assert.doesNotMatch(body.error, BLAMES_FILE);
    const retryAfter = Number(headers?.['Retry-After']);
    assert.ok(retryAfter >= 15 && retryAfter <= 30, `Retry-After ${headers?.['Retry-After']} for ${error.upstreamStatus}`);
  }
  assert.match(windbgUploadFailureResponse(upstreamError(507)).body.error, /temporarily out of space/i);
  assert.equal(windbgUploadFailureResponse(upstreamError(429, { retryAfter: '20' })).headers['Retry-After'], '20');
});

test('upstream auth/config failures are a non-retryable 502 that does not blame the file (#325, #327)', () => {
  for (const status of [401, 403, 407]) {
    const { status: http, body } = windbgUploadFailureResponse(upstreamError(status));
    assert.equal(http, 502, `upstream ${status}`);
    assert.equal(body.code, 'WINDBG_UPLOAD_FAILED');
    assert.equal(body.retryable, false);
    assert.doesNotMatch(body.error, BLAMES_FILE);
  }
});

test('every upstream 4xx/5xx gets an answer consistent with its class; only 400/413/415/422 blame the file (#327)', () => {
  const rejected = new Set([400, 413, 415, 422]);
  const retryLater = new Set([408, 409, 423, 425, 429, 507]);
  for (let status = 400; status <= 599; status++) {
    const { status: http, body } = windbgUploadFailureResponse(upstreamError(status));
    if (rejected.has(status)) {
      assert.equal(body.code, 'WINDBG_UPLOAD_REJECTED', `upstream ${status}`);
      continue;
    }
    assert.notEqual(http, 422, `upstream ${status}`);
    assert.notEqual(body.code, 'WINDBG_UPLOAD_REJECTED', `upstream ${status}`);
    assert.doesNotMatch(body.error, BLAMES_FILE, `upstream ${status}`);
    assert.equal(typeof body.retryable, 'boolean', `upstream ${status} says whether a retry helps`);
    if (retryLater.has(status)) assert.equal(body.retryable, true, `upstream ${status}`);
    if (status < 500 && !retryLater.has(status)) {
      assert.deepEqual([http, body.code, body.retryable], [502, 'WINDBG_UPLOAD_FAILED', false], `upstream ${status}`);
    }
  }
});

test('the WinDbg-API submit answer set maps to the documented classes (#327)', () => {
  // windbg-server JobEndpoints.cs: 400 not a dump, 401 key, 413 too large,
  // 429 queue full / per-key limit, 507 storage pressure.
  const answer = status => {
    const { status: http, body } = windbgUploadFailureResponse(upstreamError(status));
    return [http, body.code, body.retryable];
  };
  assert.deepEqual(answer(400), [422, 'WINDBG_UPLOAD_REJECTED', false]);
  assert.deepEqual(answer(401), [502, 'WINDBG_UPLOAD_FAILED', false]);
  assert.deepEqual(answer(413), [422, 'WINDBG_UPLOAD_REJECTED', false]);
  assert.deepEqual(answer(429), [503, 'WINDBG_UPLOAD_RETRY_LATER', true]);
  assert.deepEqual(answer(507), [503, 'WINDBG_UPLOAD_RETRY_LATER', true]);
});

test('/api/analyze classifies submit failures the same way as the upload route (#327)', () => {
  for (let status = 400; status <= 599; status++) {
    const error = upstreamError(status);
    const kind = classifyWinDbgSubmitFailure(error).kind;
    const upload = windbgUploadFailureResponse(error);
    const analyze = analyzeSubmitFailureResponse(error, 1);
    assert.equal(analyze.status === 422, upload.status === 422, `upstream ${status}`);
    assert.equal(analyze.body.code === 'DUMP_REJECTED', kind === 'rejected', `upstream ${status}`);
    if (kind === 'retry_later') {
      assert.equal(analyze.status, 503, `upstream ${status}`);
      assert.equal(analyze.body.code, 'ANALYSIS_RETRY_LATER');
      assert.equal(analyze.body.retryable, true);
      assert.equal(analyze.headers['Retry-After'], upload.headers['Retry-After']);
    }
  }
});

// Issue #328: WinDbg-API has no idempotency key or file-hash dedupe (#140),
// so only a failure that guarantees no job was created may be retried.
const UNCONFIRMED = /may still be processing/i;

test('ambiguous upstream outcomes are non-retryable and say the upload may still be processing (#328)', () => {
  const ambiguous = [
    ...[500, 501, 502, 503, 504, 520, 522, 524, 530, 599].map(status => upstreamError(status)),
    Object.assign(new Error('returned invalid JSON'), { code: 'WINDBG_UPSTREAM_INVALID_JSON', upstreamStatus: 200 }),
    Object.assign(new Error('WinDBG job submit response did not include job_id'), { code: 'WINDBG_UPSTREAM_NO_JOB_ID', upstreamStatus: 202 }),
    Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) }),
    Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) })
  ];
  for (const error of ambiguous) {
    const { status: http, body } = windbgUploadFailureResponse(error);
    const label = `${error.upstreamStatus ?? error.cause?.code ?? error.code}`;
    assert.equal(http, 502, label);
    assert.equal(body.code, 'WINDBG_UPLOAD_UNCONFIRMED', label);
    assert.equal(body.retryable, false, label);
    assert.match(body.error, UNCONFIRMED, label);
    assert.equal(isUnconfirmedSubmitFailure(error), true, label);
  }
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const { status, body } = windbgUploadFailureResponse(timeout);
  assert.deepEqual([status, body.code, body.retryable], [504, 'WINDBG_UPLOAD_UNCONFIRMED', false]);
  assert.equal(isUnconfirmedSubmitFailure(timeout), true);
});

test('a connection that was never established is a retryable 502; nothing was created upstream (#328)', () => {
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
    const error = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
    const { status: http, body, headers } = windbgUploadFailureResponse(error);
    assert.deepEqual([http, body.code, body.retryable], [502, 'WINDBG_UPLOAD_UNREACHABLE', true], code);
    assert.equal(headers['Retry-After'], '15');
    assert.equal(isUnconfirmedSubmitFailure(error), false, code);
    const analyze = analyzeSubmitFailureResponse(error, 1);
    assert.deepEqual([analyze.status, analyze.body.code, analyze.body.retryable], [503, 'ANALYSIS_RETRY_LATER', true], code);
  }
});

test('only failures that guarantee nothing was created are retryable (#328, #140)', () => {
  const retryable = new Set([408, 409, 423, 425, 429, 507, 521, 523, 525, 526]);
  for (let status = 400; status <= 599; status++) {
    assert.equal(windbgUploadFailureResponse(upstreamError(status)).body.retryable, retryable.has(status), `upstream ${status}`);
    assert.equal(windbgUploadFailureResponse(upstreamError(status, { retryAfter: '10' })).body.retryable, retryable.has(status) || status === 503, `upstream ${status} with Retry-After`);
  }
  for (const status of [400, 401, 413, 429, 507, 408]) assert.equal(isUnconfirmedSubmitFailure(upstreamError(status)), false, `upstream ${status}`);
});

test('a local failure stays a 500 the browser does not retry (#325)', () => {
  const { status, body } = windbgUploadFailureResponse(new Error('ENOSPC'));
  assert.equal(status, 500);
  assert.equal(isUnconfirmedSubmitFailure(new Error('ENOSPC')), false);
  assert.notEqual(body.retryable, true);
});

test('winDbgUpstreamHttpStatus keeps its status/download mapping', () => {
  assert.equal(winDbgUpstreamHttpStatus(upstreamError(400)), 502);
  assert.equal(winDbgUpstreamHttpStatus(upstreamError(503)), 502);
  assert.equal(winDbgUpstreamHttpStatus({ code: 'WINDBG_UPSTREAM_INVALID_JSON' }), 502);
  assert.equal(winDbgUpstreamHttpStatus({ name: 'AbortError' }), 504);
  assert.equal(winDbgUpstreamHttpStatus(new Error('boom')), 500);
});

// Issue #334: a reset or refused connection to WinDbg-API during a status poll
// or download answered a code-less 500, which the browser's poll does not
// retry. Both are idempotent reads, so a transport failure is a 502.
test('a transport failure on the status poll or download is a coded 502 (#334)', () => {
  const transport = code => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'EPIPE']) {
    assert.equal(winDbgUpstreamHttpStatus(transport(code)), 502, code);
    assert.equal(winDbgUpstreamFailureCode(transport(code)), 'WINDBG_UPSTREAM_UNREACHABLE', code);
  }
  assert.equal(winDbgUpstreamHttpStatus(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), 502);
  assert.equal(winDbgUpstreamFailureCode({ code: 'WINDBG_UPSTREAM_INVALID_JSON' }), 'WINDBG_UPSTREAM_INVALID_JSON');
  assert.equal(winDbgUpstreamFailureCode({ name: 'AbortError' }), 'WINDBG_UPSTREAM_TIMEOUT');
  // A local failure keeps the 500, now with a code.
  assert.equal(winDbgUpstreamHttpStatus(new Error('boom')), 500);
  assert.equal(winDbgUpstreamFailureCode(new Error('boom')), 'INTERNAL_ERROR');
});

test('the status and download routes answer with winDbgUpstreamFailureCode (#334)', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  for (const [from, to] of [["app.get('/api/windbg/status'", "app.get('/api/windbg/download'"], ["app.get('/api/windbg/download'", '// ====']]) {
    const start = server.indexOf(from);
    const route = server.slice(start, server.indexOf(to, start + from.length));
    assert.match(route, /res\.status\(winDbgUpstreamHttpStatus\(error\)\)\.json\(\{[^}]*code: winDbgUpstreamFailureCode\(error\)/, from);
  }
});

test('the upload route answers its failures through windbgUploadFailureResponse (#325)', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const route = server.slice(server.indexOf("app.post('/api/windbg/upload'"), server.indexOf("app.get('/api/windbg/status'"));
  assert.ok(route.length > 0);
  assert.match(route, /log\.error\('windbg\.upload\.fail'[^]{0,200}windbgUploadFailureResponse\(error\)/);
  assert.doesNotMatch(route, /winDbgUpstreamHttpStatus\(error\)/);
});

test('the upload route holds a dump whose earlier submit failed ambiguously (#328)', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const submitter = server.slice(server.indexOf('const windbgUploadSubmitter = createWinDbgUploadSubmitter('), server.indexOf('const EXTERNAL_ANALYZE_MAX_CONCURRENT'));
  assert.match(submitter, /isUnconfirmedFailure: isUnconfirmedSubmitFailure/);
  const route = server.slice(server.indexOf("app.post('/api/windbg/upload'"), server.indexOf("app.get('/api/windbg/status'"));
  assert.match(route, /submitted\.outcome === 'unconfirmed'[^]{0,600}status\(409\)[^]{0,400}code: 'WINDBG_UPLOAD_PENDING',\s*retryable: false/);
});

// Issue #335: Cloudflare answers 521 (origin refused the connection), 523
// (origin unreachable), 525 (TLS handshake failed) and 526 (invalid origin
// certificate) without delivering the request to WinDbg-API, so no job can
// exist. They were classified unconfirmed: a hard failure plus a 10 min hold
// for every upload during a WinDbg-API restart.
test('Cloudflare origin-not-reached statuses are retryable and never held (#335)', () => {
  for (const status of [521, 523, 525, 526]) {
    const error = upstreamError(status);
    assert.equal(classifyWinDbgSubmitFailure(error).kind, 'unreachable', `upstream ${status}`);
    assert.equal(isUnconfirmedSubmitFailure(error), false, `upstream ${status}`);
    const { status: http, body, headers } = windbgUploadFailureResponse(error);
    assert.deepEqual([http, body.code, body.retryable], [502, 'WINDBG_UPLOAD_UNREACHABLE', true], `upstream ${status}`);
    assert.equal(headers['Retry-After'], '15');
    const analyze = analyzeSubmitFailureResponse(error, 1);
    assert.deepEqual([analyze.status, analyze.body.code, analyze.body.retryable], [503, 'ANALYSIS_RETRY_LATER', true], `upstream ${status}`);
    assert.equal(analyze.headers['Retry-After'], '15');
  }
});

test('Cloudflare statuses that can follow a delivered request stay unconfirmed (#335, #328)', () => {
  // 520 empty/invalid origin answer, 522 connect OR request-ACK timeout,
  // 524 origin took the request and did not answer within 100 s.
  for (const status of [520, 522, 524, 530]) {
    assert.equal(classifyWinDbgSubmitFailure(upstreamError(status)).kind, 'unconfirmed', `upstream ${status}`);
    assert.equal(isUnconfirmedSubmitFailure(upstreamError(status)), true, `upstream ${status}`);
  }
});

// Issue #340: WinDbg-API's 429 is either "queue full" (clears in seconds) or
// "this API key's quota is exhausted" (clears in up to an hour). Every 429 was
// a retryable 503 with Retry-After clamped to 15-30 s, so a quota 429 cost up
// to six full-dump POSTs before the local fallback.
const PER_KEY_429 = 'WinDBG job submit failed with status 429: Rate limit exceeded for this API key';

test('a 429 that cannot clear within seconds is a non-retryable WINDBG_UPLOAD_LIMITED (#340)', () => {
  const cases = [
    [upstreamError(429, { message: PER_KEY_429 }), undefined],
    [upstreamError(429, { upstreamCode: 'RATE_LIMITED' }), undefined],
    [upstreamError(429, { upstreamCode: 'RATE_LIMITED', retryAfter: '3600' }), '3600'],
    [upstreamError(429, { retryAfter: '120' }), '120'],
    [upstreamError(429, { upstreamCode: 'QUEUE_FULL', retryAfter: '45' }), '45']
  ];
  for (const [error, retryAfter] of cases) {
    const label = `${error.upstreamCode ?? error.message} / ${error.retryAfter}`;
    assert.equal(classifyWinDbgSubmitFailure(error).kind, 'limited', label);
    assert.equal(isUnconfirmedSubmitFailure(error), false, label);
    const { status, body, headers } = windbgUploadFailureResponse(error);
    assert.deepEqual([status, body.code, body.retryable], [503, 'WINDBG_UPLOAD_LIMITED', false], label);
    assert.match(body.error, /limit/i, label);
    assert.match(body.error, /locally/i, label);
    assert.doesNotMatch(body.error, BLAMES_FILE, label);
    assert.doesNotMatch(body.error, /server is busy/i, 'the browser must not take it for a busy answer');
    assert.equal(headers?.['Retry-After'], retryAfter, label);
    const analyze = analyzeSubmitFailureResponse(error, 1);
    assert.deepEqual([analyze.status, analyze.body.code, analyze.body.retryable], [503, 'ANALYSIS_LIMITED', false], label);
    assert.equal(analyze.headers?.['Retry-After'], retryAfter, label);
  }
});

test('a 429 that can clear within seconds stays retryable and honours Retry-After (#340, #327)', () => {
  const cases = [
    [upstreamError(429), '15'],
    [upstreamError(429, { upstreamCode: 'QUEUE_FULL' }), '15'],
    [upstreamError(429, { retryAfter: '20' }), '20'],
    [upstreamError(429, { retryAfter: '30' }), '30'],
    [upstreamError(429, { upstreamCode: 'RATE_LIMITED', retryAfter: '25' }), '25'],
    [upstreamError(429, { message: PER_KEY_429, retryAfter: '2' }), '15']
  ];
  for (const [error, retryAfter] of cases) {
    const label = `${error.upstreamCode ?? error.message} / ${error.retryAfter}`;
    const { status, body, headers } = windbgUploadFailureResponse(error);
    assert.deepEqual([status, body.code, body.retryable, headers['Retry-After']], [503, 'WINDBG_UPLOAD_RETRY_LATER', true, retryAfter], label);
  }
  const at = new Date(Date.now() + 10 * 60_000).toUTCString();
  assert.equal(classifyWinDbgSubmitFailure(upstreamError(429, { retryAfter: at })).kind, 'limited', 'HTTP-date Retry-After');
});
