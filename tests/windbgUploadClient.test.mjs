import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { rolldown } from 'rolldown';

// Browser-side WinDBG upload leg (services/windbgService.ts).
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));

async function loadModule(relativePath) {
  const bundle = await rolldown({
    input: path.join(root, relativePath),
    plugins: [{
      name: 'resolve-ts-from-js-specifier',
      async resolveId(source, importer) {
        if (source.startsWith('.') && source.endsWith('.js') && importer) {
          const candidate = path.resolve(path.dirname(importer), source.slice(0, -3) + '.ts');
          try {
            await fs.access(candidate);
            return candidate;
          } catch {
            return null;
          }
        }
        return null;
      }
    }]
  });
  const { output } = await bundle.generate({ format: 'esm' });
  const encoded = Buffer.from(output[0].code, 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${encoded}#${relativePath}`);
}

function installBrowserStubs(t) {
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    XMLHttpRequest: globalThis.XMLHttpRequest
  };
  globalThis.window = new EventTarget();
  globalThis.window.localStorage = { getItem: () => null, setItem() {} };
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  doc.cookie = '';
  globalThis.document = doc;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) globalThis[key] = value;
  });
}

const okUpload = { success: true, data: { uid: 'x', status: 'pending', handle: 'h' } };

test('uploadToWinDBG sends the uid field before the file part (#244)', async t => {
  installBrowserStubs(t);
  let sentBody = null;
  globalThis.XMLHttpRequest = class {
    upload = {};
    open() {}
    setRequestHeader() {}
    send(body) {
      sentBody = body;
      this.status = 200;
      this.responseText = JSON.stringify(okUpload);
      queueMicrotask(() => this.onload());
    }
    abort() {}
  };
  const { uploadToWinDBG } = await loadModule('services/windbgService.ts');
  const file = new File([new Uint8Array([0x4d, 0x44, 0x4d, 0x50])], 'crash.dmp');
  await uploadToWinDBG(file);
  assert.ok(sentBody instanceof FormData);
  assert.deepEqual([...sentBody.keys()], ['uid', 'file']);
});

// Fake clock driving setTimeout/clearTimeout so long upload timelines run instantly.
function installFakeClock(t) {
  const saved = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  globalThis.setTimeout = (fn, ms = 0) => {
    const id = nextId++;
    timers.set(id, { at: now + ms, fn });
    return id;
  };
  globalThis.clearTimeout = id => { timers.delete(id); };
  t.after(() => Object.assign(globalThis, saved));
  return {
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        let due = null;
        for (const [id, timer] of timers) {
          if (timer.at <= end && (!due || timer.at < due[1].at)) due = [id, timer];
        }
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await new Promise(r => setImmediate(r));
      }
      now = end;
      await new Promise(r => setImmediate(r));
    }
  };
}

// XHR stub that honours the real `timeout` property semantics: a total timer
// from send() to the response.
function installControllableXhr() {
  const state = { xhr: null, aborted: false, sends: 0 };
  globalThis.XMLHttpRequest = class {
    upload = {};
    timeout = 0;
    responseHeaders = {};
    open() {}
    setRequestHeader() {}
    getResponseHeader(name) {
      return this.responseHeaders[name.toLowerCase()] ?? null;
    }
    send() {
      state.xhr = this;
      state.sends++;
      if (this.timeout > 0) {
        setTimeout(() => this.ontimeout?.(), this.timeout);
      }
    }
    abort() {
      state.aborted = true;
      queueMicrotask(() => this.onabort?.());
    }
    respond(body) {
      this.status = 200;
      this.responseText = JSON.stringify(body);
      this.onload();
    }
  };
  return state;
}

async function startUpload(t) {
  installBrowserStubs(t);
  const { uploadToWinDBG } = await loadModule('services/windbgService.ts');
  const clock = installFakeClock(t);
  const state = installControllableXhr();
  const file = new File([new Uint8Array([0x4d, 0x44, 0x4d, 0x50])], 'crash.dmp');
  const outcome = uploadToWinDBG(file).then(v => ({ ok: v }), e => ({ err: e }));
  // Let the hash + XHR send happen. file.arrayBuffer() and the SHA-256 digest
  // run off the event loop, so how many turns they take depends on machine
  // load: wait on real elapsed time, not a fixed number of turns.
  for (const start = Date.now(); !state.xhr && Date.now() - start < 30_000;) await new Promise(r => setImmediate(r));
  assert.ok(state.xhr, 'upload XHR was sent');
  return { clock, state, outcome };
}

test('a slow upload that keeps making progress is not cut off by a fixed total timeout (#234)', async t => {
  const { clock, state, outcome } = await startUpload(t);
  const total = 100 * 1024 * 1024;
  // 400 s of steady progress: longer than the old 240 s total budget.
  for (let s = 20; s <= 400; s += 20) {
    await clock.advance(20_000);
    state.xhr.upload.onprogress?.({ lengthComputable: true, loaded: Math.round(total * s / 400), total });
  }
  state.xhr.upload.onload?.();
  // Server buffers and submits upstream for up to its own 240 s budget.
  await clock.advance(239_000);
  state.xhr.respond(okUpload);
  const result = await outcome;
  assert.equal(result.err, undefined, result.err?.message);
  assert.equal(result.ok.success, true);
});

test('an upload that stalls without progress times out (#234)', async t => {
  const { clock, state, outcome } = await startUpload(t);
  state.xhr.upload.onprogress?.({ lengthComputable: true, loaded: 1000, total: 100_000 });
  await clock.advance(120_000);
  const result = await Promise.race([outcome, new Promise(r => setImmediate(() => r({ err: new Error('still pending') })))]);
  assert.match(result.err?.message || '', /Upload timed out/);
  assert.equal(state.aborted, true);
});

test('a response that never arrives after the body is sent times out (#234)', async t => {
  const { clock, state, outcome } = await startUpload(t);
  state.xhr.upload.onprogress?.({ lengthComputable: true, loaded: 100_000, total: 100_000 });
  state.xhr.upload.onload?.();
  await clock.advance(30 * 60_000);
  const result = await Promise.race([outcome, new Promise(r => setImmediate(() => r({ err: new Error('still pending') })))]);
  assert.match(result.err?.message || '', /Upload timed out/);
  assert.equal(state.aborted, true);
});

async function queuedMessageFor(t, uploadData) {
  installBrowserStubs(t);
  const saved = { fetch: globalThis.fetch, setTimeout: globalThis.setTimeout };
  t.after(() => Object.assign(globalThis, saved));
  globalThis.setTimeout = (fn, ms) => {
    if (ms <= 60 * 1000) queueMicrotask(fn);
    return 0;
  };
  globalThis.XMLHttpRequest = class {
    upload = {};
    open() {}
    setRequestHeader() {}
    send() {
      this.status = 200;
      this.responseText = JSON.stringify({ success: true, data: uploadData });
      queueMicrotask(() => this.onload());
    }
    abort() {}
  };
  globalThis.fetch = async url => {
    if (String(url).startsWith('/api/windbg/status')) {
      return new Response(JSON.stringify({ success: true, data: { status: 'completed' } }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true, analysisText: 'BUGCHECK_CODE: d1' }), { status: 200 });
  };
  const { analyzeWithWinDBG } = await loadModule('services/windbgService.ts');
  const messages = [];
  const file = new File([new Uint8Array([0x4d, 0x44, 0x4d, 0x50])], 'crash.dmp');
  const result = await analyzeWithWinDBG(file, (stage, message) => messages.push([stage, message]));
  assert.equal(result.success, true, result.error);
  return messages.filter(([stage]) => stage === 'queued').map(([, message]) => message)[0];
}

test('upload progress never reports "position 0" for an unknown queue position (#271)', async t => {
  assert.equal(await queuedMessageFor(t, { uid: 'x', status: 'pending', queue_position: 0, handle: 'h' }), 'Waiting for WinDBG server...');
});

test('upload progress omits the position when the server sends none (#271)', async t => {
  assert.equal(await queuedMessageFor(t, { uid: 'x', status: 'pending', handle: 'h' }), 'Waiting for WinDBG server...');
});

test('upload progress shows a real queue position (#271)', async t => {
  assert.equal(await queuedMessageFor(t, { uid: 'x', status: 'pending', queue_position: 3, handle: 'h' }), 'Queued for analysis (position 3)');
});

// --- Outer WinDBG budget (#278) and transient upload failures (#276) ---

const flush = async (n = 50) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

// fetch stub for the poll/download legs; a 'hang' answer waits until the
// request's signal aborts, like a real fetch.
function installWinDbgFetch(t, { download = 'ok', status = 'completed' } = {}) {
  const saved = globalThis.fetch;
  t.after(() => { globalThis.fetch = saved; });
  const calls = { status: 0, download: 0, downloadSignals: [] };
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith('/api/windbg/status')) {
      calls.status++;
      return new Response(JSON.stringify({ success: true, data: { status } }), { status: 200 });
    }
    calls.download++;
    calls.downloadSignals.push(init.signal);
    if (download === 'hang') {
      return new Promise((_, reject) => {
        if (!init.signal) return;
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }
    return new Response(JSON.stringify({ success: true, analysisText: 'BUGCHECK_CODE: d1' }), { status: 200 });
  };
  return calls;
}

async function startAnalysis(t, { size = 4, fetchOptions, signal, onProgress } = {}) {
  installBrowserStubs(t);
  const { analyzeWithWinDBG } = await loadModule('services/windbgService.ts');
  const calls = installWinDbgFetch(t, fetchOptions);
  const clock = installFakeClock(t);
  const state = installControllableXhr();
  const bytes = new Uint8Array(size);
  bytes.set([0x4d, 0x44, 0x4d, 0x50]);
  const file = new File([bytes], 'crash.dmp');
  const outcome = analyzeWithWinDBG(file, onProgress, undefined, signal);
  // Hashing a large file takes real time (more under a loaded test run).
  for (const start = Date.now(); !state.xhr && Date.now() - start < 30_000;) await new Promise(r => setImmediate(r));
  assert.ok(state.xhr, 'upload XHR was sent');
  return { clock, state, calls, outcome };
}

test('the outer WinDBG timeout aborts an upload still in flight instead of orphaning it (#278)', async t => {
  const { clock, state, outcome } = await startAnalysis(t);
  let settled = null;
  outcome.then(v => { settled = v; });
  // A 4-byte file still "uploading" after 25 minutes: progress keeps the
  // inactivity timer quiet, so only the outer budget can stop it.
  for (let s = 30; s <= 1500 && !settled; s += 30) {
    await clock.advance(30_000);
    if (!state.aborted) state.xhr.upload.onprogress?.({ lengthComputable: true, loaded: s, total: 1500 });
  }
  await flush();
  assert.ok(settled, 'the analysis settled');
  assert.equal(settled.success, false);
  assert.match(settled.error, /timed out/);
  assert.equal(state.aborted, true, 'the XHR was aborted, not left uploading in the background');
});

test('a large upload that keeps progressing past 11 minutes still reaches polling (#278)', async t => {
  const size = 40 * 1024 * 1024;
  const { clock, state, calls, outcome } = await startAnalysis(t, { size });
  // 40 MB at ~34 KB/s: 20 minutes of steady progress.
  for (let s = 30; s <= 1200; s += 30) {
    await clock.advance(30_000);
    state.xhr.upload.onprogress?.({ lengthComputable: true, loaded: Math.round(size * s / 1200), total: size });
  }
  state.xhr.upload.onload?.();
  await clock.advance(5_000);
  assert.equal(state.aborted, false, 'a progressing upload is not cut off');
  state.xhr.respond(okUpload);
  await flush();
  await clock.advance(60_000);
  const result = await outcome;
  assert.equal(result.success, true, result.error);
  assert.ok(calls.status > 0, 'the job was polled');
  assert.equal(calls.download, 1);
});

test('the outer WinDBG timeout aborts a hung download (#278)', async t => {
  const { clock, state, calls, outcome } = await startAnalysis(t, { fetchOptions: { download: 'hang' } });
  state.xhr.upload.onload?.();
  state.xhr.respond(okUpload);
  await flush();
  await clock.advance(30_000);
  assert.equal(calls.download, 1, 'download started');
  assert.ok(calls.downloadSignals[0], 'the download carries an abort signal');
  await clock.advance(20 * 60_000);
  await flush();
  const result = await Promise.race([outcome, new Promise(r => setImmediate(() => r({ pending: true })))]);
  assert.equal(result.pending, undefined, 'the analysis settled');
  assert.equal(result.success, false);
  assert.match(result.error, /timed out/);
  assert.equal(calls.downloadSignals[0].aborted, true, 'the download request was aborted');
});

test('cancelling the run aborts a download in flight (#278)', async t => {
  const controller = new AbortController();
  const { clock, state, calls, outcome } = await startAnalysis(t, { fetchOptions: { download: 'hang' }, signal: controller.signal });
  state.xhr.upload.onload?.();
  state.xhr.respond(okUpload);
  await flush();
  await clock.advance(30_000);
  assert.equal(calls.download, 1);
  controller.abort();
  await flush();
  const result = await Promise.race([outcome, new Promise(r => setImmediate(() => r({ pending: true })))]);
  assert.equal(result.pending, undefined, 'the analysis settled');
  assert.equal(result.errorCode, 'ABORTED');
  assert.equal(calls.downloadSignals[0].aborted, true);
});

// Answers the current upload XHR, as the server or the edge would.
function answerUpload(state, status, body, headers = {}) {
  const xhr = state.xhr;
  xhr.status = status;
  xhr.responseText = typeof body === 'string' ? body : JSON.stringify(body);
  xhr.responseHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  xhr.onload();
}

// Waits (real time: the retry re-hashes the file off the event loop) for the
// next upload XHR after `previous`; returns null when none comes.
async function nextUpload(state, previous, waitMs = 30_000) {
  for (const start = Date.now(); state.xhr === previous && Date.now() - start < waitMs;) await new Promise(r => setImmediate(r));
  return state.xhr === previous ? null : state.xhr;
}

// Fails every upload attempt the same way and returns the final result.
async function failEveryUpload(t, status, body, headers) {
  const { clock, state, outcome } = await startAnalysis(t);
  let settled = null;
  outcome.then(v => { settled = v; });
  for (let i = 0; i < 6 && !settled; i++) {
    const xhr = state.xhr;
    answerUpload(state, status, body, headers);
    await flush();
    await clock.advance(30_000);
    if (!settled) await nextUpload(state, xhr, 5_000);
  }
  const result = await outcome;
  return { result, sends: state.sends };
}

const SLOW_SUBMIT = { success: false, error: 'The debugging server is slow to accept the upload. Please retry in a moment.', code: 'WINDBG_UPLOAD_TIMEOUT', retryable: true };

test('the server\'s retryable 504 is retried after Retry-After and the retry joins the job (#307)', async t => {
  const progress = [];
  const { clock, state, calls, outcome } = await startAnalysis(t, { onProgress: (stage, message) => progress.push([stage, message]) });
  const first = state.xhr;
  answerUpload(state, 504, SLOW_SUBMIT, { 'Retry-After': '15' });
  await flush();
  assert.ok(progress.some(([, m]) => /still submitting to the WinDBG server/i.test(m) && /retrying/i.test(m)), JSON.stringify(progress));

  // Not before Retry-After has passed.
  await clock.advance(14_000);
  assert.equal(await nextUpload(state, first, 200), null, 'no retry before Retry-After');
  await clock.advance(1_000);
  const second = await nextUpload(state, first);
  assert.ok(second, 'the upload was retried');
  assert.equal(state.sends, 2);

  answerUpload(state, 200, okUpload);
  await flush();
  await clock.advance(60_000);
  const result = await outcome;
  assert.equal(result.success, true, result.error);
  assert.ok(calls.status > 0, 'the joined job was polled');
});

test('each upload retry reports the uploading stage again before the dump is re-sent (#326)', async t => {
  const progress = [];
  let sends = () => 0;
  const { clock, state, outcome } = await startAnalysis(t, { onProgress: (stage, message) => progress.push([stage, message, sends()]) });
  sends = () => state.sends;
  const first = state.xhr;
  answerUpload(state, 504, SLOW_SUBMIT, { 'Retry-After': '15' });
  await flush();
  assert.equal(progress.at(-1)[0], 'queued', 'the wait itself is reported as queued');
  await clock.advance(15_000);
  const second = await nextUpload(state, first);
  assert.ok(second, 'the upload was retried');
  const retrying = progress.findIndex(([stage, message]) => stage === 'uploading' && message === 'Retrying upload of crash.dmp...');
  assert.ok(retrying > 0, JSON.stringify(progress));
  assert.equal(progress[retrying][2], 1, 'reported before the second send');
  assert.equal(progress.at(-1)[0], 'uploading', 'nothing moves the stage off uploading during the re-upload');

  answerUpload(state, 200, okUpload);
  await flush();
  await clock.advance(60_000);
  assert.equal((await outcome).success, true);
});

test('the retryable 504 is retried at most twice, then its code reaches the caller (#307, #276)', async t => {
  const { result, sends } = await failEveryUpload(t, 504, SLOW_SUBMIT, { 'Retry-After': '15' });
  assert.equal(sends, 3, 'one upload and two retries');
  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'WINDBG_UPLOAD_TIMEOUT');
  assert.match(result.error, /slow to accept the upload/);
});

test('a non-JSON 524 from the upload endpoint is retried, then reported as a transient, clearly worded failure (#307, #276)', async t => {
  const { result, sends } = await failEveryUpload(t, 524, '<!DOCTYPE html><title>A timeout occurred | Cloudflare</title>');
  assert.equal(sends, 3);
  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'WINDBG_UPLOAD_TRANSIENT');
  assert.doesNotMatch(result.error, /Invalid response/);
  assert.match(result.error, /524/);
  assert.match(result.error, /try again/i);
});

test('a non-JSON 502 from the upload endpoint is transient too (#307, #276)', async t => {
  const { result, sends } = await failEveryUpload(t, 502, 'Bad Gateway');
  assert.equal(sends, 3);
  assert.equal(result.errorCode, 'WINDBG_UPLOAD_TRANSIENT');
});

test('a code-less JSON gateway 5xx marked retryable is retried and reported as transient (#307, #276, #325)', async t => {
  const { result, sends } = await failEveryUpload(t, 502, { success: false, error: 'Failed to upload file to the debugging server. Please try again later.', retryable: true });
  assert.equal(sends, 3);
  assert.equal(result.errorCode, 'WINDBG_UPLOAD_TRANSIENT');
});

test('an upload WinDbg-API permanently rejected is not retried (#325)', async t => {
  const { result, sends } = await failEveryUpload(t, 422, {
    success: false,
    error: 'The debugging server rejected this file.',
    code: 'WINDBG_UPLOAD_REJECTED',
    retryable: false
  });
  assert.equal(sends, 1);
  assert.equal(result.errorCode, 'WINDBG_UPLOAD_REJECTED');
});

test('a code-less JSON 5xx that says retryable:false is not retried (#325)', async t => {
  const { result, sends } = await failEveryUpload(t, 502, { success: false, error: 'Failed to upload file to the debugging server.', retryable: false });
  assert.equal(sends, 1);
  assert.notEqual(result.errorCode, 'WINDBG_UPLOAD_TRANSIENT');
});

test('a code-less JSON 5xx that does not say retryable is not retried (#325)', async t => {
  // The upload route's "not configured" answer: a 503 that will not clear up in 15 s.
  const { result, sends } = await failEveryUpload(t, 503, { success: false, error: 'WinDBG service not configured' });
  assert.equal(sends, 1);
  assert.notEqual(result.errorCode, 'WINDBG_UPLOAD_TRANSIENT');
});

test('any upload answer marked retryable is retried (#307)', async t => {
  const { result, sends } = await failEveryUpload(t, 503, { success: false, error: 'Try again shortly.', code: 'SOMETHING_ELSE', retryable: true });
  assert.equal(sends, 3);
  assert.equal(result.errorCode, 'SOMETHING_ELSE');
});

test('a non-retryable upload failure is not retried (#307)', async t => {
  const { result, sends } = await failEveryUpload(t, 400, { success: false, error: 'Invalid dump file', code: 'INVALID_FILE' });
  assert.equal(sends, 1);
  assert.equal(result.errorCode, 'INVALID_FILE');
});

test('a huge Retry-After is capped (#307)', async t => {
  const { clock, state, outcome } = await startAnalysis(t);
  const first = state.xhr;
  answerUpload(state, 504, SLOW_SUBMIT, { 'Retry-After': '3600' });
  await flush();
  await clock.advance(30_000);
  assert.ok(await nextUpload(state, first), 'retried within 30 s despite Retry-After: 3600');
  answerUpload(state, 200, okUpload);
  await flush();
  await clock.advance(60_000);
  assert.equal((await outcome).success, true);
});

test('cancelling the run during the retry wait stops at once without another upload (#307)', async t => {
  const controller = new AbortController();
  const { state, outcome } = await startAnalysis(t, { signal: controller.signal });
  const first = state.xhr;
  answerUpload(state, 504, SLOW_SUBMIT, { 'Retry-After': '15' });
  await flush();
  controller.abort();
  await flush();
  const result = await Promise.race([outcome, new Promise(r => setImmediate(() => r({ pending: true })))]);
  assert.equal(result.pending, undefined, 'the analysis settled without waiting out Retry-After');
  assert.equal(result.errorCode, 'ABORTED');
  assert.equal(await nextUpload(state, first, 200), null);
  assert.equal(state.sends, 1);
});

const RETRY_LATER = { success: false, error: 'The analysis server is temporarily out of space. Please try again in a few minutes.', code: 'WINDBG_UPLOAD_RETRY_LATER', retryable: true };

test('a retry-later answer (507 storage pressure) is retried after its Retry-After, reported as a busy server (#327)', async t => {
  const progress = [];
  const { clock, state, outcome } = await startAnalysis(t, { onProgress: (stage, message) => progress.push([stage, message]) });
  const first = state.xhr;
  answerUpload(state, 503, RETRY_LATER, { 'Retry-After': '30' });
  await flush();
  assert.ok(progress.some(([stage, m]) => stage === 'queued' && /busy/i.test(m) && /30s/.test(m)), JSON.stringify(progress));
  assert.ok(!progress.some(([, m]) => /still submitting/i.test(m)), 'nothing is being submitted while the server is busy');
  await clock.advance(29_000);
  assert.equal(await nextUpload(state, first, 200), null, 'no retry before Retry-After');
  await clock.advance(1_000);
  assert.ok(await nextUpload(state, first), 'retried after Retry-After');
  answerUpload(state, 200, okUpload);
  await flush();
  await clock.advance(60_000);
  assert.equal((await outcome).success, true);
});

test('the AI fallback prompt only calls the dump rejected for WINDBG_UPLOAD_REJECTED (#327)', async () => {
  const { describeWinDbgFailureForPrompt } = await loadModule('services/windbgService.ts');
  const rejected = Object.assign(new Error('The debugging server rejected this file.'), { code: 'WINDBG_UPLOAD_REJECTED' });
  assert.match(describeWinDbgFailureForPrompt(rejected), /rejected this file/);
  for (const failure of [
    Object.assign(new Error('The debugging server rejected this file.'), { code: 'WINDBG_UPLOAD_FAILED' }),
    'The debugging server rejected this file. Please ensure it is a supported Windows crash dump.',
    Object.assign(new Error('Upload rejected: not a supported crash dump'), { code: undefined })
  ]) {
    const text = describeWinDbgFailureForPrompt(failure);
    assert.doesNotMatch(text, /reject|supported Windows crash dump/i, String(failure));
    assert.match(text, /not a finding about the dump/i);
  }
  const busy = Object.assign(new Error('The analysis server is temporarily out of space.'), { code: 'WINDBG_UPLOAD_RETRY_LATER' });
  assert.match(describeWinDbgFailureForPrompt(busy), /temporarily out of space/);
  assert.equal(describeWinDbgFailureForPrompt(null), 'Unknown WinDBG failure');
});

test('an unconfirmed upload (the server may still be processing it) is not re-sent (#328)', async t => {
  const { result, sends } = await failEveryUpload(t, 502, {
    success: false,
    error: 'The debugging server did not confirm the upload and may still be processing it.',
    code: 'WINDBG_UPLOAD_UNCONFIRMED',
    retryable: false
  });
  assert.equal(sends, 1);
  assert.equal(result.errorCode, 'WINDBG_UPLOAD_UNCONFIRMED');
});

test('a re-run held after an unconfirmed upload is not re-sent (#328)', async t => {
  const { result, sends } = await failEveryUpload(t, 409, {
    success: false,
    error: 'This dump was sent to the debugging server recently and may still be processing.',
    code: 'WINDBG_UPLOAD_PENDING',
    retryable: false
  });
  assert.equal(sends, 1);
  assert.equal(result.errorCode, 'WINDBG_UPLOAD_PENDING');
});

test('a debugging server at its submission limit is not re-sent (#340)', async t => {
  const { windbgUploadFailureResponse } = await import('../server/windbgUploadFailure.js');
  const answer = windbgUploadFailureResponse(Object.assign(new Error('WinDBG job submit failed with status 429: Rate limit exceeded for this API key'), {
    code: 'WINDBG_UPSTREAM_ERROR', upstreamStatus: 429, retryAfter: '3600'
  }));
  const { result, sends } = await failEveryUpload(t, answer.status, answer.body, answer.headers);
  assert.equal(sends, 1);
  assert.equal(result.errorCode, 'WINDBG_UPLOAD_LIMITED');
});

test('an unreachable debugging server (nothing was sent) is retried (#328)', async t => {
  const { result, sends } = await failEveryUpload(t, 502, {
    success: false, error: 'The debugging server could not be reached.', code: 'WINDBG_UPLOAD_UNREACHABLE', retryable: true
  }, { 'Retry-After': '15' });
  assert.equal(sends, 3);
  assert.equal(result.errorCode, 'WINDBG_UPLOAD_UNREACHABLE');
});

// Issue #338: the busy branch retried at 1.5 s and 3 s whatever Retry-After
// said, so a dump refused at the per-instance submit cap was uploaded three
// times in about five seconds.
const BUSY = { success: false, error: 'Server is busy. Please retry shortly.', code: 'WINDBG_UPLOAD_BUSY' };

test('a busy upload is retried after its Retry-After, not after 1.5 s (#338)', async t => {
  const progress = [];
  const { clock, state, outcome } = await startAnalysis(t, { onProgress: (stage, message) => progress.push([stage, message]) });
  const first = state.xhr;
  answerUpload(state, 429, BUSY, { 'Retry-After': '15' });
  await flush();
  assert.ok(progress.some(([stage, m]) => stage === 'queued' && /busy/i.test(m) && /15s/.test(m)), JSON.stringify(progress));
  await clock.advance(14_000);
  assert.equal(await nextUpload(state, first, 200), null, 'no re-upload before Retry-After');
  await clock.advance(1_000);
  assert.ok(await nextUpload(state, first), 'retried after Retry-After');
  answerUpload(state, 200, okUpload);
  await flush();
  await clock.advance(60_000);
  assert.equal((await outcome).success, true);
});

test('a busy upload is retried at most twice, then reaches the caller (#338)', async t => {
  const { result, sends } = await failEveryUpload(t, 429, BUSY, { 'Retry-After': '15' });
  assert.equal(sends, 3);
  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'WINDBG_UPLOAD_BUSY');
});

test('the upload carries its file hash so the server can admit a join before reading the body (#338)', async t => {
  installBrowserStubs(t);
  const headers = {};
  globalThis.XMLHttpRequest = class {
    upload = {};
    open() {}
    setRequestHeader(name, value) { headers[name.toLowerCase()] = value; }
    getResponseHeader() { return null; }
    send() {
      this.status = 200;
      this.responseText = JSON.stringify(okUpload);
      queueMicrotask(() => this.onload());
    }
    abort() {}
  };
  const { uploadToWinDBG, generateFileHash } = await loadModule('services/windbgService.ts');
  const file = new File([new Uint8Array([0x4d, 0x44, 0x4d, 0x50])], 'crash.dmp');
  await uploadToWinDBG(file);
  assert.equal(headers['x-file-hash'], await generateFileHash(file));
  assert.match(headers['x-file-hash'], /^[a-f0-9]{64}$/);
});

test('a busy wait that would outlast the upload-phase budget falls back at once instead of re-uploading (#338)', async t => {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  t.after(() => { Date.now = realNow; });
  const { clock, state, outcome } = await startAnalysis(t);
  let settled = null;
  outcome.then(v => { settled = v; });
  // 640 s into a 660 s upload-phase budget (progress keeps the XHR alive)...
  for (let s = 0; s < 640; s += 40) {
    await clock.advance(40_000);
    offset += 40_000;
    state.xhr.upload.onprogress?.({ lengthComputable: true, loaded: s, total: 1000 });
  }
  const first = state.xhr;
  // ...a 30 s Retry-After cannot end inside the budget.
  answerUpload(state, 429, BUSY, { 'Retry-After': '30' });
  await flush();
  assert.ok(settled, 'the analysis fell back without sleeping into the budget timeout');
  assert.equal(settled.errorCode, 'WINDBG_UPLOAD_BUSY');
  assert.equal(await nextUpload(state, first, 200), null);
  assert.equal(state.sends, 1);
});

// Issue #344: isBusyError also matched the message "Server is busy", and the
// retry_later answer says "The debugging server is busy right now", so it was
// retried on the busy budget and then on the retryable one: 5 uploads.
async function upstreamFailureAnswer(upstreamStatus, message, retryAfter) {
  const { windbgUploadFailureResponse } = await import('../server/windbgUploadFailure.js');
  return windbgUploadFailureResponse(Object.assign(new Error(`WinDBG job submit failed with status ${upstreamStatus}: ${message}`), {
    code: 'WINDBG_UPSTREAM_ERROR', upstreamStatus, ...(retryAfter ? { retryAfter } : {})
  }));
}

test('a busy WinDbg-API (queue-full 429) is uploaded at most three times, like other retryable failures (#344)', async t => {
  const answer = await upstreamFailureAnswer(429, 'Job queue is full');
  assert.equal(answer.body.code, 'WINDBG_UPLOAD_RETRY_LATER');
  const { result, sends } = await failEveryUpload(t, answer.status, answer.body, answer.headers);
  assert.equal(sends, 3, 'one upload and two retries');
  assert.equal(result.errorCode, 'WINDBG_UPLOAD_RETRY_LATER');
});

test('an out-of-space WinDbg-API (507) is uploaded at most three times (#344)', async t => {
  const answer = await upstreamFailureAnswer(507, 'Insufficient storage');
  assert.equal(answer.body.code, 'WINDBG_UPLOAD_RETRY_LATER');
  const { result, sends } = await failEveryUpload(t, answer.status, answer.body, answer.headers);
  assert.equal(sends, 3);
  assert.equal(result.errorCode, 'WINDBG_UPLOAD_RETRY_LATER');
});

test('only the WINDBG_UPLOAD_BUSY code makes an upload busy, not its wording (#344)', async t => {
  const { result, sends } = await failEveryUpload(t, 503, { success: false, error: 'Server is busy. Please retry shortly.', code: 'SOMETHING_ELSE' });
  assert.equal(sends, 1, 'a non-retryable answer that only says "busy" is not re-sent');
  assert.equal(result.errorCode, 'SOMETHING_ELSE');
});
