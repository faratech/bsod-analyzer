import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { rolldown } from 'rolldown';

// Browser-side AI leg of the analyzer (services/geminiProxy.ts): how
// /api/gemini/generateContent failures, cancellation and cache hits reach the
// per-file result. fetch and XMLHttpRequest are stubbed; nothing touches the
// network.
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

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' }
});

const aiAnswer = report => json(200, { text: JSON.stringify(report) });

function installBrowserStubs(t) {
  const saved = {
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    window: globalThis.window,
    document: globalThis.document,
    XMLHttpRequest: globalThis.XMLHttpRequest,
    FileReader: globalThis.FileReader,
    log: console.log,
    warn: console.warn,
    error: console.error
  };
  globalThis.setTimeout = (fn, ms) => {
    if (ms <= 60 * 1000) queueMicrotask(fn);
    return 0;
  };
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  globalThis.window = new EventTarget();
  globalThis.window.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  doc.cookie = '';
  globalThis.document = doc;
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then(result => {
        this.result = result;
        this.onload?.({ target: this });
      });
    }
  };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (key === 'log' || key === 'warn' || key === 'error') console[key] = value;
      else globalThis[key] = value;
    }
  });
}

// Upload leg: 'fail' makes WinDBG unavailable (local AI path runs), 'cached'
// answers with a finished WinDBG analysis (the AI interprets it).
function installUploadStub(mode, analysisText = 'BUGCHECK_CODE: d1\nMODULE_NAME: foo\nIMAGE_NAME: foo.sys') {
  globalThis.XMLHttpRequest = class {
    upload = {};
    open() {}
    setRequestHeader() {}
    send() {
      if (mode === 'fail') {
        this.status = 503;
        this.responseText = JSON.stringify({ success: false, error: 'WinDBG unavailable', code: 'WINDBG_UNAVAILABLE' });
      } else {
        this.status = 200;
        this.responseText = JSON.stringify({
          success: true,
          cached: true,
          cachedAnalysis: analysisText,
          data: { uid: 'x', handle: 'h' }
        });
      }
      queueMicrotask(() => this.onload());
    }
    abort() {}
  };
}

const dumpFile = (extra = {}) => {
  const bytes = new Uint8Array(4096);
  bytes.set([0x4d, 0x44, 0x4d, 0x50]);
  return { id: 'f1', file: new File([bytes], 'crash.dmp'), dumpType: 'minidump', status: 'ANALYZING', ...extra };
};

async function analyzeOne(analyzeDumpFiles, file, options) {
  const results = await analyzeDumpFiles([file], undefined, undefined, undefined, options);
  return results[0];
}

let proxyModule;
const loadProxy = async () => (proxyModule ??= await loadModule('services/geminiProxy.ts'));

test('non-JSON edge failures on generateContent surface as transient, not as an API-key problem (#230, #219)', async t => {
  installBrowserStubs(t);
  installUploadStub('fail');
  const { analyzeDumpFiles } = await loadProxy();

  const cases = [
    [524, '<!DOCTYPE html><html><title>524: A timeout occurred</title></html>', 'text/html'],
    [520, '<html>Web server returned an unknown error</html>', 'text/html'],
    [408, 'Request Timeout', 'text/plain'],
    [502, '<html>Bad gateway</html>', 'text/html']
  ];
  for (const [status, body, type] of cases) {
    let bodyReads = 0;
    globalThis.fetch = async url => {
      if (String(url).includes('generateContent')) {
        const response = new Response(body, { status, headers: { 'Content-Type': type } });
        const text = response.text.bind(response);
        const jsonRead = response.json.bind(response);
        response.text = () => { bodyReads++; return text(); };
        response.json = () => { bodyReads++; return jsonRead(); };
        return response;
      }
      return json(404, {});
    };
    const result = await analyzeOne(analyzeDumpFiles, dumpFile());
    assert.equal(result.status, 'ERROR', `status ${status}`);
    assert.doesNotMatch(result.error, /API key/i, `status ${status}`);
    assert.match(result.error, /busy or temporarily unavailable/, `status ${status}`);
    assert.equal(bodyReads, 1, `status ${status}: the body is read once`);
  }
});

test('an unmapped non-JSON failure keeps its status and body text (#219, #230)', async t => {
  installBrowserStubs(t);
  installUploadStub('fail');
  const { analyzeDumpFiles } = await loadProxy();

  globalThis.fetch = async url => {
    if (String(url).includes('generateContent')) {
      return new Response('Blocked by edge rule 1234', { status: 403, headers: { 'Content-Type': 'text/plain' } });
    }
    return json(404, {});
  };
  const result = await analyzeOne(analyzeDumpFiles, dumpFile());
  assert.equal(result.status, 'ERROR');
  assert.doesNotMatch(result.error, /API key/i);
  assert.match(result.error, /403/);
  assert.match(result.error, /Blocked by edge rule 1234/);
});

test('a transient AI failure after a successful WinDBG run ends in a retryable ERROR (#232)', async t => {
  installBrowserStubs(t);
  installUploadStub('cached');
  const { analyzeDumpFiles } = await loadProxy();

  for (const [status, pattern] of [[503, /busy or temporarily unavailable/], [429, /Rate limit/], [524, /busy or temporarily unavailable/]]) {
    let aiCalls = 0;
    globalThis.fetch = async url => {
      if (String(url).includes('generateContent')) {
        aiCalls++;
        return status === 524
          ? new Response('<html>524</html>', { status, headers: { 'Content-Type': 'text/html' } })
          : json(status, { error: status === 429 ? 'Rate limit exceeded - too many requests' : 'The analysis service is busy or temporarily unavailable - please try again shortly' });
      }
      return json(404, {});
    };
    const result = await analyzeOne(analyzeDumpFiles, dumpFile());
    assert.equal(result.status, 'ERROR', `AI ${status}: ${JSON.stringify(result.report?.probableCause)}`);
    assert.match(result.error, pattern);
    assert.equal(result.report, undefined);
    assert.equal(aiCalls, 1, `AI ${status}: no local-analysis fallback after WinDBG succeeded`);
  }
});

test('a transient AI failure on a cached WinDBG analysis ends in ERROR without re-uploading (#232)', async t => {
  installBrowserStubs(t);
  let uploads = 0;
  globalThis.XMLHttpRequest = class {
    upload = {};
    open() {}
    setRequestHeader() {}
    send() { uploads++; this.status = 503; this.responseText = '{}'; queueMicrotask(() => this.onload()); }
    abort() {}
  };
  const { analyzeDumpFiles } = await loadProxy();

  globalThis.fetch = async url => {
    if (String(url).startsWith('/api/cache/get')) {
      return json(200, { success: true, cached: true, windbgAnalysis: 'BUGCHECK_CODE: d1\nMODULE_NAME: foo', aiReport: null });
    }
    if (String(url).includes('generateContent')) return json(503, { error: 'busy' });
    return json(404, {});
  };
  const result = await analyzeOne(analyzeDumpFiles, dumpFile({ knownCached: true, fileHash: 'a'.repeat(64) }));
  assert.equal(result.status, 'ERROR');
  assert.equal(uploads, 0);
});

test('a delivered but unparseable AI answer on a WinDBG run keeps the placeholder report (#232)', async t => {
  installBrowserStubs(t);
  installUploadStub('cached');
  const { analyzeDumpFiles } = await loadProxy();

  globalThis.fetch = async url => {
    if (String(url).includes('generateContent')) return json(200, { text: 'not json at all' });
    return json(404, {});
  };
  const result = await analyzeOne(analyzeDumpFiles, dumpFile());
  assert.equal(result.status, 'ANALYZED');
  assert.equal(result.analysisMethod, 'windbg');
  assert.match(result.report.probableCause, /Analysis completed by WinDBG server/);
  assert.equal(result.report.culprit, 'foo');
});

// generateContent stub that hangs until its signal aborts (like a real fetch).
function abortableAiFetch(seen) {
  return async (url, init) => {
    if (!String(url).includes('generateContent')) return json(404, {});
    seen.push(init?.signal);
    seen.onCall?.();
    if (!init?.signal) return aiAnswer({ summary: 's', probableCause: 'c', culprit: 'foo.sys', recommendations: [] });
    return new Promise((resolve, reject) => {
      if (init.signal.aborted) reject(new DOMException('aborted', 'AbortError'));
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
  };
}

test('cancelling a run aborts the in-flight generateContent request on every AI path (#235)', async t => {
  installBrowserStubs(t);
  const { analyzeDumpFiles } = await loadProxy();

  const largeBytes = new Uint8Array(6 * 1024 * 1024);
  largeBytes.set([0x50, 0x41, 0x47, 0x45]);
  const paths = [
    ['WinDBG report', 'cached', () => dumpFile()],
    ['local analysis', 'fail', () => dumpFile()],
    ['large-dump failover', 'fail', () => dumpFile({ file: new File([largeBytes], 'big.dmp'), dumpType: 'kernel' })]
  ];
  for (const [label, uploadMode, makeFile] of paths) {
    installUploadStub(uploadMode);
    const controller = new AbortController();
    const seen = [];
    seen.onCall = () => queueMicrotask(() => controller.abort());
    globalThis.fetch = abortableAiFetch(seen);
    const completed = [];
    const results = await analyzeDumpFiles([makeFile()], undefined, r => completed.push(r), undefined, { signal: controller.signal });
    assert.equal(seen.length, 1, `${label}: one AI request, no retry`);
    assert.ok(seen[0], `${label}: generateContent fetch carries the run's signal`);
    assert.equal(seen[0].aborted, true, `${label}: the request was aborted`);
    assert.equal(results[0].status, 'ERROR', label);
    assert.equal(completed.length, 0, `${label}: a cancelled run reports nothing`);
  }
});

test('WinDBG-fallback prompts redact profile folder names and emails from dump strings (issue #345)', async t => {
  installBrowserStubs(t);
  installUploadStub('fail');
  const { analyzeDumpFiles } = await loadProxy();

  const evidence = 'C:\\Users\\JohnDoe\\AppData\\Local\\Temp\\evil.sys owner john.doe@example.com \\SystemRoot\\System32\\drivers\\nvlddmkm.sys';
  const withEvidence = (size, magic, offset) => {
    const bytes = new Uint8Array(size);
    bytes.set(magic);
    bytes.set(Buffer.from(evidence, 'latin1'), offset);
    bytes.set(Buffer.from(evidence, 'utf16le'), offset + 512);
    return bytes;
  };
  const paths = [
    ['local analysis', dumpFile({ file: new File([withEvidence(8192, [0x4d, 0x44, 0x4d, 0x50], 6000)], 'crash.dmp') })],
    ['large-dump failover', dumpFile({ file: new File([withEvidence(6 * 1024 * 1024, [0x50, 0x41, 0x47, 0x45], 6 * 1024 * 1024 - 2048)], 'big.dmp'), dumpType: 'kernel' })]
  ];
  for (const [label, file] of paths) {
    const prompts = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('generateContent')) {
        prompts.push(JSON.stringify(JSON.parse(init.body)));
        return aiAnswer({ summary: 'Limited failover analysis', probableCause: 'x', culprit: 'x', recommendations: [] });
      }
      return json(404, {});
    };
    await analyzeOne(analyzeDumpFiles, file);
    assert.equal(prompts.length, 1, label);
    const prompt = prompts[0];
    assert.ok(prompt.includes('evil.sys'), `${label}: the dump strings are in the prompt`);
    assert.doesNotMatch(prompt, /JohnDoe|john\.doe@example\.com/, label);
    assert.match(prompt, /Users\\\\<user>\\\\AppData/, label);
    assert.match(prompt, /<email>/, label);
    assert.match(prompt, /System32\\\\drivers\\\\nvlddmkm\.sys/, `${label}: driver paths stay intact`);
  }
});

// A minimal MDMP whose first thread's stack (Memory64ListStream) holds the
// given bytes, so the full local path hex-dumps it.
function minidumpWithStack(size, stack) {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x504d444d, true); // MDMP
  view.setUint32(8, 2, true); // stream count
  view.setUint32(12, 0x20, true); // stream directory
  view.setUint32(0x20, 3, true); // ThreadListStream
  view.setUint32(0x24, 4 + 48, true);
  view.setUint32(0x28, 0x40, true);
  view.setUint32(0x2c, 9, true); // Memory64ListStream
  view.setUint32(0x30, 32, true);
  view.setUint32(0x34, 0x80, true);
  view.setUint32(0x40, 1, true); // one thread
  view.setUint32(0x44, 7, true); // thread id
  const contextRva = 0x100;
  view.setUint32(0x44 + 40, 0x4d0, true);
  view.setUint32(0x44 + 44, contextRva, true);
  view.setBigUint64(contextRva + 0x98, 0x10000n, true); // RSP
  const stackRva = 0x1400;
  view.setBigUint64(0x80, 1n, true); // one range
  view.setBigUint64(0x88, BigInt(stackRva), true); // base RVA
  view.setBigUint64(0x90, 0x10000n, true); // start address
  view.setBigUint64(0x98, BigInt(stack.length), true);
  bytes.set(stack, stackRva);
  return bytes;
}

// The hex dumps in a prompt, turned back into the bytes they show (hex column).
function hexDumpBytes(prompt) {
  const out = [];
  for (const block of prompt.matchAll(/```hex\n([\s\S]*?)```/g)) {
    for (const line of block[1].split('\n')) {
      const m = /^[0-9a-f]{8} {2}((?:[0-9a-fx]{2} ?)+)/i.exec(line);
      if (m) out.push(...m[1].trim().split(' ').map(b => (/^[0-9a-f]{2}$/i.test(b) ? parseInt(b, 16) : 0)));
    }
  }
  return Buffer.from(out);
}

test('hex-dumped byte excerpts in fallback prompts carry no profile names or emails in any encoding (issue #359)', async t => {
  installBrowserStubs(t);
  installUploadStub('fail');
  const { analyzeDumpFiles } = await loadProxy();

  const secrets = ['jsmith', 'John Smith', 'john.doe@example.com', 'DESKTOP-JD1234'];
  const stack = new Uint8Array(0x800).fill(0xcc);
  stack.set(Buffer.from('ith\\AppData\\Local', 'latin1'), 0); // a string cut by the excerpt's start
  stack.set(Buffer.from('C:\\Users\\jsmith\\AppData\\x.dll\0', 'utf16le'), 0x40);
  stack.set(Buffer.from('USERPROFILE=C:\\Users\\John Smith\0COMPUTERNAME=DESKTOP-JD1234\0', 'utf16le'), 0x101);
  stack.set(Buffer.from('C:\\Users\\jsmith\\Desktop\\a.txt mail john.doe@example.com\0', 'latin1'), 0x300);

  const local = minidumpWithStack(0x2000, stack);
  // In the 4 KB file-head excerpt: UTF-16 and ASCII paths, and an email
  // crossing its end ("x john.doe@exa" inside, the rest after it).
  local.set(Buffer.from('C:\\Users\\jsmith\\NTUSER.DAT\0', 'utf16le'), 0x600);
  local.set(Buffer.from('owner john.doe@example.com C:\\Users\\jsmith\\x\0', 'latin1'), 0x700);
  local.set(Buffer.from('C:\\Users\\jsmith\\x\0', 'latin1'), 0xa00 - 12);
  local.set(Buffer.from('x john.doe@example.com\0', 'latin1'), 4096 - 14);
  local.set(Buffer.from('\\SystemRoot\\System32\\drivers\\nvlddmkm.sys\0', 'utf16le'), 0x800);

  const large = new Uint8Array(6 * 1024 * 1024);
  large.set([0x50, 0x41, 0x47, 0x45]);
  large.set(Buffer.from('C:\\Users\\jsmith\\AppData\\x.dll\0', 'utf16le'), 0x200);
  large.set(Buffer.from('mail john.doe@example.com\0', 'latin1'), 0x300);

  const paths = [
    ['local analysis', dumpFile({ file: new File([local], 'crash.dmp') }), true],
    ['large-dump failover', dumpFile({ file: new File([large], 'big.dmp'), dumpType: 'kernel' }), false]
  ];
  for (const [label, file, hasStack] of paths) {
    const prompts = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('generateContent')) {
        prompts.push(JSON.parse(init.body).contents);
        return aiAnswer({ summary: 'Limited failover analysis', probableCause: 'x', culprit: 'x', recommendations: [] });
      }
      return json(404, {});
    };
    await analyzeOne(analyzeDumpFiles, file);
    assert.equal(prompts.length, 1, label);
    const prompt = typeof prompts[0] === 'string' ? prompts[0] : JSON.stringify(prompts[0]);
    if (hasStack) assert.match(prompt, /Thread Stack Memory/, `${label}: the stack excerpt is in the prompt`);
    const shown = hexDumpBytes(prompt);
    assert.ok(shown.length >= 4096, `${label}: hex excerpts present (${shown.length} bytes)`);
    const decoded = [shown.toString('latin1'), shown.toString('utf16le'), shown.subarray(1).toString('utf16le')].join('\n');
    for (const secret of secrets) {
      assert.ok(!decoded.includes(secret), `${label}: ${secret} in the hex bytes`);
      assert.ok(!prompt.includes(secret), `${label}: ${secret} in the prompt text`);
    }
    assert.ok(!decoded.includes('john.doe'), `${label}: no email fragment at the excerpt end`);
    // The ASCII column shows UTF-16 as "j.s.m.i.t.h."; it must not either.
    assert.doesNotMatch(prompt, /j\.s\.m\.i\.t\.h/, label);
    assert.ok(decoded.includes('\\Users\\******\\'), `${label}: the mask is visible in place`);
    if (hasStack) {
      assert.ok(decoded.includes('\\SystemRoot\\System32\\drivers\\nvlddmkm.sys'), `${label}: driver paths stay intact`);
      assert.ok(!decoded.includes('ith\\AppData\\Local'), `${label}: the cut-off string at the stack start is masked`);
    }
  }
});

test('a run cancelled after WinDBG finishes never issues the AI request (#235)', async t => {
  installBrowserStubs(t);
  installUploadStub('cached');
  const { analyzeDumpFiles } = await loadProxy();

  const controller = new AbortController();
  const seen = [];
  globalThis.fetch = abortableAiFetch(seen);
  const onProgress = stage => { if (stage === 'analyzing') controller.abort(); };
  const results = await analyzeDumpFiles([dumpFile()], onProgress, undefined, undefined, { signal: controller.signal });
  assert.equal(seen.length, 0);
  assert.equal(results[0].status, 'ERROR');
});

test('cache hits render the same WinDBG-merged report and bugCheck as a fresh run (#237)', async t => {
  installBrowserStubs(t);
  const { analyzeDumpFiles } = await loadProxy();

  // Kernel dump header carrying a structured bug check (PAGEDU64 @0x38).
  const bytes = new Uint8Array(0x2000);
  bytes.set(new TextEncoder().encode('PAGEDU64'));
  const view = new DataView(bytes.buffer);
  view.setUint32(0x38, 0xD1, true);
  view.setBigUint64(0x40, 0x10n, true);
  view.setBigUint64(0x48, 0x2n, true);
  view.setBigUint64(0x50, 0x0n, true);
  view.setBigUint64(0x58, 0xfffff80012345678n, true);
  const makeFile = extra => dumpFile({ file: new File([bytes], 'crash.dmp'), dumpType: 'minidump', ...extra });

  const windbgAnalysis = 'BUGCHECK_CODE: d1\nFAILURE_BUCKET_ID: AV_foo!bar\nSYMBOL_NAME: foo!bar+12\nMODULE_NAME: foo\nIMAGE_NAME: foo.sys\nPROCESS_NAME: System';
  const aiReport = { summary: 'Driver foo.sys crashed', probableCause: 'foo bug', culprit: 'foo.sys', recommendations: ['Update foo'] };
  const hash = 'b'.repeat(64);

  // Fresh run: WinDBG upload answers with the analysis, the AI interprets it.
  installUploadStub('cached', windbgAnalysis);
  globalThis.fetch = async url => (String(url).includes('generateContent') ? aiAnswer(aiReport) : json(404, {}));
  const fresh = await analyzeOne(analyzeDumpFiles, makeFile());
  assert.equal(fresh.status, 'ANALYZED');
  assert.equal(fresh.report.failureBucketId, 'AV_foo!bar');
  assert.equal(fresh.report.bugCheck?.code, '0x000000D1');

  // Hash fast path: the cache already holds the raw AI report.
  globalThis.fetch = async url => (String(url).startsWith('/api/cache/get')
    ? json(200, { success: true, cached: true, windbgAnalysis, aiReport })
    : json(404, {}));
  const fastPath = await analyzeOne(analyzeDumpFiles, makeFile({ knownCached: true, fileHash: hash }));
  assert.equal(fastPath.status, 'ANALYZED');
  assert.equal(fastPath.cached, true);
  assert.deepEqual(fastPath.report, fresh.report);

  // Cached WinDBG analysis without an AI report: AI runs, same post-AI steps.
  globalThis.fetch = async url => {
    if (String(url).startsWith('/api/cache/get')) return json(200, { success: true, cached: true, windbgAnalysis, aiReport: null });
    if (String(url).includes('generateContent')) return aiAnswer(aiReport);
    return json(404, {});
  };
  const cachedWinDbg = await analyzeOne(analyzeDumpFiles, makeFile({ knownCached: true, fileHash: hash }));
  assert.equal(cachedWinDbg.status, 'ANALYZED');
  assert.deepEqual(cachedWinDbg.report, fresh.report);
});

// Issue #331: when only the AI step failed, Retry re-ran the whole pipeline:
// the dump was uploaded again and WinDbg-API queued a second job.
function countingUploadStub(analysisText = 'BUGCHECK_CODE: d1\nMODULE_NAME: foo\nIMAGE_NAME: foo.sys') {
  const counter = { uploads: 0 };
  globalThis.XMLHttpRequest = class {
    upload = {};
    open() {}
    setRequestHeader() {}
    send() {
      counter.uploads++;
      this.status = 200;
      this.responseText = JSON.stringify({ success: true, cached: true, cachedAnalysis: analysisText, data: { uid: 'c'.repeat(64), handle: 'signed-handle' } });
      queueMicrotask(() => this.onload());
    }
    abort() {}
  };
  return counter;
}

test('an AI-only failure keeps the WinDBG result and a retry runs only the AI step (issue #331)', async t => {
  installBrowserStubs(t);
  const counter = countingUploadStub();
  const { analyzeDumpFiles } = await loadProxy();

  const aiBodies = [];
  let aiUp = false;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('generateContent')) {
      aiBodies.push(JSON.parse(init.body));
      return aiUp
        ? aiAnswer({ summary: 's', probableCause: 'c', culprit: 'foo.sys', recommendations: [] })
        : json(503, { error: 'The analysis service is busy or temporarily unavailable - please try again shortly' });
    }
    return json(404, {});
  };

  const failed = await analyzeOne(analyzeDumpFiles, dumpFile());
  assert.equal(failed.status, 'ERROR');
  assert.equal(counter.uploads, 1);
  assert.ok(failed.windbgResult, 'the WinDBG result travels with the ERROR');
  assert.match(failed.windbgResult.analysisText, /BUGCHECK_CODE: d1/);
  assert.match(failed.windbgResult.fileHash, /^[0-9a-f]{64}$/);
  assert.equal(typeof failed.windbgResult.completedAt, 'number');

  // Retry: no upload, one AI call with the same evidence and the file handle.
  aiUp = true;
  const retried = await analyzeOne(analyzeDumpFiles, dumpFile({ status: 'ANALYZING', windbgResult: failed.windbgResult }));
  assert.equal(retried.status, 'ANALYZED');
  assert.equal(retried.analysisMethod, 'windbg');
  assert.equal(counter.uploads, 1, 'Retry made no upload');
  assert.equal(aiBodies.length, 2);
  assert.equal(aiBodies[1].fileHash, failed.windbgResult.fileHash);
  assert.equal(aiBodies[1].fileHandle, 'signed-handle');
  assert.equal(retried.windbgResult, undefined);
});

test('a stored WinDBG result older than the ownership window falls back to the full pipeline (issue #331)', async t => {
  installBrowserStubs(t);
  const counter = countingUploadStub();
  const { analyzeDumpFiles, WINDBG_RESULT_REUSE_MS } = await loadProxy();
  assert.ok(WINDBG_RESULT_REUSE_MS > 0 && WINDBG_RESULT_REUSE_MS < 60 * 60 * 1000, 'below the server\'s one-hour ownership window');
  globalThis.fetch = async url => (String(url).includes('generateContent')
    ? aiAnswer({ summary: 's', probableCause: 'c', culprit: 'foo.sys', recommendations: [] })
    : json(404, {}));

  const stale = { analysisText: 'BUGCHECK_CODE: d1', completedAt: Date.now() - WINDBG_RESULT_REUSE_MS - 1000 };
  const result = await analyzeOne(analyzeDumpFiles, dumpFile({ windbgResult: stale }));
  assert.equal(result.status, 'ANALYZED');
  assert.equal(counter.uploads, 1, 'stale result: uploaded again');
});

// Issue #341: the file handle a kept WinDBG result relies on is signed for the
// session that uploaded the dump. SSO re-verification (/api/auth/wf/exchange)
// and Turnstile verification mint a new session, after which the retried AI
// request failed the server's ownership check silently (prompt not rebuilt,
// corpus row unlinked, no crash signal). Retry must upload again instead.
// geminiProxy, wfAuth and sessionManager are bundled together so they share
// one session module, as in the app.
async function loadWithAuth() {
  const entry = `
    export * from ${JSON.stringify(path.join(root, 'services/geminiProxy.ts'))};
    export { exchangeToken } from ${JSON.stringify(path.join(root, 'services/wfAuth.ts'))};
    export { noteNewSession, clearSessionState } from ${JSON.stringify(path.join(root, 'utils/sessionManager.ts'))};
  `;
  const bundle = await rolldown({
    input: 'entry',
    logLevel: 'silent',
    plugins: [{
      name: 'entry',
      resolveId: id => (id === 'entry' ? id : null),
      load: id => (id === 'entry' ? entry : null)
    }]
  });
  const { output } = await bundle.generate({ format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(output[0].code, 'utf8').toString('base64')}#with-auth`);
}

function handleIssuingUploadStub() {
  const counter = { uploads: 0 };
  globalThis.XMLHttpRequest = class {
    upload = {};
    open() {}
    setRequestHeader() {}
    send() {
      counter.uploads++;
      this.status = 200;
      this.responseText = JSON.stringify({ success: true, cached: true, cachedAnalysis: 'BUGCHECK_CODE: d1\nMODULE_NAME: foo\nIMAGE_NAME: foo.sys', data: { uid: 'c'.repeat(64), handle: `handle-session-${counter.uploads}` } });
      queueMicrotask(() => this.onload());
    }
    abort() {}
  };
  return counter;
}

function aiStub() {
  const state = { up: false, bodies: [] };
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/auth/wf/exchange')) return json(200, { success: true, user: { id: 1, username: 'u' } });
    if (String(url).includes('generateContent')) {
      state.bodies.push(JSON.parse(init.body));
      return state.up
        ? aiAnswer({ summary: 's', probableCause: 'c', culprit: 'foo.sys', recommendations: [] })
        : json(503, { error: 'The analysis service is busy or temporarily unavailable - please try again shortly' });
    }
    return json(404, {});
  };
  return state;
}

for (const [label, changeSession] of [
  ['an SSO exchange', async m => assert.ok(await m.exchangeToken('sso-token'))],
  ['a Turnstile verification', async m => m.noteNewSession()],
  ['a cleared session', async m => m.clearSessionState(false)],
]) {
  test(`a retry after ${label} uploads again instead of reusing the old session's handle (issue #341)`, async t => {
    installBrowserStubs(t);
    const counter = handleIssuingUploadStub();
    const ai = aiStub();
    const m = await loadWithAuth();

    const failed = await analyzeOne(m.analyzeDumpFiles, dumpFile());
    assert.equal(failed.status, 'ERROR');
    assert.ok(failed.windbgResult);
    assert.equal(counter.uploads, 1);

    await changeSession(m);
    ai.up = true;
    const retried = await analyzeOne(m.analyzeDumpFiles, dumpFile({ windbgResult: failed.windbgResult }));
    assert.equal(retried.status, 'ANALYZED');
    assert.equal(counter.uploads, 2, 'the new session uploads the dump again');
    assert.equal(ai.bodies.at(-1).fileHandle, 'handle-session-2', 'the AI request proves ownership with the new session\'s handle');
  });
}

test('a retry in the same session still runs only the AI step (issues #331, #341)', async t => {
  installBrowserStubs(t);
  const counter = handleIssuingUploadStub();
  const ai = aiStub();
  const m = await loadWithAuth();

  const failed = await analyzeOne(m.analyzeDumpFiles, dumpFile());
  assert.equal(failed.status, 'ERROR');
  ai.up = true;
  const retried = await analyzeOne(m.analyzeDumpFiles, dumpFile({ windbgResult: failed.windbgResult }));
  assert.equal(retried.status, 'ANALYZED');
  assert.equal(counter.uploads, 1, 'no second upload');
  assert.equal(ai.bodies.at(-1).fileHandle, 'handle-session-1');
});

test('a kept result without a session generation is not reused (issue #341)', async t => {
  installBrowserStubs(t);
  const counter = handleIssuingUploadStub();
  aiStub().up = true;
  const m = await loadWithAuth();
  const legacy = { analysisText: 'BUGCHECK_CODE: d1', fileHash: 'c'.repeat(64), completedAt: Date.now() };
  const result = await analyzeOne(m.analyzeDumpFiles, dumpFile({ windbgResult: legacy }));
  assert.equal(result.status, 'ANALYZED');
  assert.equal(counter.uploads, 1);
});

test('the Turnstile verification success path marks a new session (issue #341)', async () => {
  const source = await fs.readFile(path.join(root, 'components/FileUploader.tsx'), 'utf8');
  const success = source.slice(source.indexOf("'/api/auth/verify-turnstile'"));
  assert.match(success.slice(0, success.indexOf('startSessionRefresh')), /noteNewSession\(\)/);
});

// The full local fallback prompt for a minidump holding `bytes`, as sent to
// /api/gemini/generateContent (prompt-redaction end-to-end tests).
async function localPromptFor(t, bytes, extra = {}) {
  installBrowserStubs(t);
  installUploadStub('fail');
  const { analyzeDumpFiles } = await loadProxy();
  const prompts = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('generateContent')) {
      prompts.push(JSON.parse(init.body).contents);
      return aiAnswer({ summary: 'Limited failover analysis', probableCause: 'x', culprit: 'x', recommendations: [] });
    }
    return json(404, {});
  };
  await analyzeOne(analyzeDumpFiles, dumpFile({ file: new File([bytes], 'crash.dmp'), ...extra }));
  assert.equal(prompts.length, 1);
  return typeof prompts[0] === 'string' ? prompts[0] : JSON.stringify(prompts[0]);
}
const hexViews = prompt => {
  const shown = hexDumpBytes(prompt);
  return [shown.toString('latin1'), shown.toString('utf16le'), shown.subarray(1).toString('utf16le')].join('\n');
};
// The prompt's text with JSON string escaping undone (\\ -> \).
const promptText = prompt => prompt.replace(/\\\\/g, '\\').replace(/\\n/g, '\n');

test('a profile path in running dump text keeps the rest of the line and the name is hunted (issue #363)', async t => {
  const local = minidumpWithStack(0x10000, new Uint8Array(0x400).fill(0xcc));
  local.set(Buffer.from('cmd.exe /c cd C:\\Users\\jsmith && start nvlddmkm-helper.exe 0xC0000005\0', 'latin1'), 0x8000);
  local.set(Buffer.from('mapped by jsmith\0', 'latin1'), 0x9000);
  const text = promptText(await localPromptFor(t, local));
  assert.ok(text.includes('cmd.exe /c cd C:\\Users\\<user> && start nvlddmkm-helper.exe 0xC0000005'), 'the rest of the line stays');
  assert.ok(text.includes('mapped by <user>'));
  assert.ok(!text.includes('jsmith'));
});

test('dozens of URL /users/ paths cannot keep the real profile name from being hunted (issue #364)', async t => {
  const local = minidumpWithStack(0x40000, new Uint8Array(0x400).fill(0xcc));
  let at = 0x2000;
  for (let i = 0; i < 40; i++) {
    const url = Buffer.from(`https://api.example.com/users/u${1000 + i}\0`, 'latin1');
    local.set(url, at);
    at += url.length + 4;
  }
  local.set(Buffer.from('C:\\Users\\jsmith\\AppData\\x.dll\0', 'utf16le'), 0x8000);
  local.set(Buffer.from('owner: jsmith\0', 'latin1'), 0x200);
  local.set(Buffer.from('mapped by jsmith\0', 'latin1'), 0x9000);
  const prompt = await localPromptFor(t, local);
  const text = promptText(prompt);
  assert.ok(text.includes('mapped by <user>'));
  assert.ok(text.includes('https://api.example.com/users/u1000'), 'URL paths stay intact');
  assert.ok(!text.includes('jsmith') && !hexViews(prompt).includes('jsmith'));
});

test('non-ASCII profile names leave no fragment in the fallback prompt, text or hex (issue #365)', async t => {
  const stack = new Uint8Array(0x400).fill(0xcc);
  stack.set(Buffer.from('Owner 田中 PC\0', 'utf16le'), 0x100);
  const local = minidumpWithStack(0x8000, stack);
  local.set(Buffer.from('C:\\Users\\Zoë Thompson\\Documents\\report.docx\0', 'utf16le'), 0x2000);
  local.set(Buffer.from('C:\\Users\\Jürgen\\AppData\\Local\\Temp\0', 'latin1'), 0x2400);
  local.set(Buffer.from('C:\\Users\\田中\\Desktop\0', 'utf16le'), 0x2800);
  local.set(Buffer.from('signed by Thompson\0', 'latin1'), 0x2c00);
  const prompt = await localPromptFor(t, local);
  const text = promptText(prompt);
  assert.match(text, /Documents\\report\.docx/, 'the dump strings are in the prompt');
  for (const fragment of ['Thompson', 'rgen\\AppData', '田中']) {
    assert.ok(!text.includes(fragment), `${fragment} in the prompt text`);
  }
  assert.ok(text.includes('signed by <user>'));
  assert.ok(!hexViews(prompt).includes('田中'), 'masked in the stack hex too');
});

// Issue #367: both prompt builders must hand the dump's names to the text
// redactor. Here the only profile path lies beyond the 25,000-char strings
// cap, so the prompt text itself never reveals the name.
test('names revealed only beyond the strings cap are still redacted in both fallback prompts (issue #367)', async t => {
  const filler = Array.from({ length: 800 }, (_, i) => `filler string number ${i} abcdefghij\0`).join('');
  const local = minidumpWithStack(0x40000, new Uint8Array(0x400).fill(0xcc));
  local.set(Buffer.from('mapped by jsmith\0', 'latin1'), 0x5000);
  local.set(Buffer.from(filler, 'latin1'), 0x6000);
  local.set(Buffer.from('C:\\Users\\jsmith\\AppData\\x.dll\0', 'utf16le'), 0x30000);
  const large = new Uint8Array(6 * 1024 * 1024);
  large.set([0x50, 0x41, 0x47, 0x45]);
  large.set(Buffer.from('mapped by jsmith\0', 'latin1'), 0x2000);
  large.set(Buffer.from(filler, 'latin1'), 0x3000);
  large.set(Buffer.from('C:\\Users\\jsmith\\AppData\\x.dll\0', 'utf16le'), large.length - 0x1000);
  for (const [label, bytes, extra] of [['local analysis', local, {}], ['large-dump failover', large, { dumpType: 'kernel' }]]) {
    const text = promptText(await localPromptFor(t, bytes, extra));
    assert.ok(text.includes('filler string number 0'), `${label}: the strings are in the prompt`);
    assert.ok(!text.includes('AppData\\x.dll'), `${label}: the profile path is past the strings cap`);
    assert.ok(text.includes('mapped by <user>'), label);
    assert.ok(!text.includes('jsmith'), label);
  }
});
