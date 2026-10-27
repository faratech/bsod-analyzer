import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { rolldown } from 'rolldown';

// Browser-side handling of transient failures: a 429/5xx (or a network blip)
// while the WinDBG job is still running upstream, or while the session is
// being refreshed in the background, must not abandon the analysis or send
// the user back to the security check.
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

// Poll/retry sleeps run immediately; the 11-minute hard timeout and the
// session refresh interval never fire.
function installBrowserStubs(t) {
  const saved = {
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    window: globalThis.window,
    document: globalThis.document,
    XMLHttpRequest: globalThis.XMLHttpRequest,
    dateNow: Date.now
  };
  globalThis.setTimeout = (fn, ms) => {
    if (ms <= 60 * 1000) queueMicrotask(fn);
    return 0;
  };
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  globalThis.window = new EventTarget();
  globalThis.window.localStorage = { getItem: () => null, setItem() {} };
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  doc.cookie = '';
  globalThis.document = doc;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (key === 'dateNow') Date.now = value;
      else globalThis[key] = value;
    }
  });
}

// XMLHttpRequest stub for the upload leg: answers with the queued job.
function installUploadStub(handle = 'signed-handle') {
  globalThis.XMLHttpRequest = class {
    upload = {};
    open() {}
    setRequestHeader() {}
    send() {
      this.status = 200;
      this.responseText = JSON.stringify({
        success: true,
        data: { uid: 'x', status: 'pending', queue_position: 0, handle }
      });
      queueMicrotask(() => this.onload());
    }
    abort() {}
  };
}

test('WinDBG polling survives transient 502/429/network errors and still downloads', async t => {
  installBrowserStubs(t);
  installUploadStub();
  const { analyzeWithWinDBG } = await loadModule('services/windbgService.ts');

  const polls = [
    () => json(502, { success: false, error: 'Failed to check WinDBG status.' }),
    () => { throw new TypeError('Failed to fetch'); },
    () => json(429, { success: false, code: 'RATE_LIMITED' }),
    () => json(200, { success: true, data: { status: 'completed', processing_time_seconds: 42 } })
  ];
  const downloads = [
    () => json(504, { success: false }),
    () => json(200, { success: true, analysisText: 'BUGCHECK_CODE: d1', analysisSignalText: 'sig' })
  ];
  globalThis.fetch = async url => {
    if (String(url).startsWith('/api/windbg/status')) return polls.shift()();
    if (String(url).startsWith('/api/windbg/download')) return downloads.shift()();
    throw new Error(`unexpected fetch ${url}`);
  };

  const file = new File([new Uint8Array([0x4d, 0x44, 0x4d, 0x50])], 'crash.dmp');
  const result = await analyzeWithWinDBG(file);
  assert.equal(result.success, true, result.error);
  assert.equal(result.analysisText, 'BUGCHECK_CODE: d1');
  assert.equal(polls.length, 0);
  assert.equal(downloads.length, 0);
});

test('WinDBG polling gives up after repeated transient failures', async t => {
  installBrowserStubs(t);
  installUploadStub();
  const { analyzeWithWinDBG } = await loadModule('services/windbgService.ts');

  let polls = 0;
  globalThis.fetch = async url => {
    if (String(url).startsWith('/api/windbg/status')) {
      polls++;
      return json(503, { success: false });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const file = new File([new Uint8Array([0x4d, 0x44, 0x4d, 0x50])], 'crash.dmp');
  const result = await analyzeWithWinDBG(file);
  assert.equal(result.success, false);
  assert.match(result.error, /HTTP 503/);
  assert.equal(polls, 4);
});

test('background session refresh keeps the session on 429/5xx and drops it on 401', async t => {
  installBrowserStubs(t);
  const session = await loadModule('utils/sessionManager.ts');

  let invalidated = 0;
  session.onSessionInvalid(() => { invalidated++; });
  let refreshStatus = 200;
  globalThis.fetch = async () => (refreshStatus === 200
    ? json(200, { success: true })
    : json(refreshStatus, { error: 'x', code: refreshStatus === 401 ? 'TURNSTILE_REQUIRED' : 'RATE_LIMITED' }));

  assert.equal(await session.initializeSession(true), true);
  session.startSessionRefresh('test');

  const realNow = Date.now();
  let offsetMinutes = 0;
  const returnToTab = async status => {
    refreshStatus = status;
    offsetMinutes += 15; // past both the refresh interval and the minimum gap
    Date.now = () => realNow + offsetMinutes * 60 * 1000;
    globalThis.document.dispatchEvent(new Event('visibilitychange'));
    await new Promise(resolve => queueMicrotask(resolve));
    await new Promise(resolve => setImmediate(resolve));
  };

  await returnToTab(429);
  await returnToTab(503);
  assert.equal(invalidated, 0, 'transient refresh failures must not invalidate the session');

  await returnToTab(401);
  assert.equal(invalidated, 1);
  session.stopSessionRefresh('test');
});
