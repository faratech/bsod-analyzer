import test from 'node:test';
import assert from 'node:assert/strict';

import { createFastifyCompatApp } from '../server/fastifyCompat.js';
import {
  buildRelatedQuery,
  createForumMcpClient,
  createForumRelatedService,
  normalizeRelatedKeys,
  parseSseMessages,
  rankRelatedResults,
  registerForumRelatedRoute,
  relatedKeysForAnalysis
} from '../server/forumRelated.js';

const KEYS = { code: '0x133', name: 'DPC_WATCHDOG_VIOLATION', module: 'nvlddmkm.sys' };

// Trimmed from a live `search` call on mcp.windowsforum.com for
// "DPC_WATCHDOG_VIOLATION 0x133 nvlddmkm.sys", plus two synthetic rows.
const LIVE_RESULTS = [
  {
    id: 'thread-263552',
    title: 'PC issues restart/freeze sound on but keyboard and monitor frozen',
    text: 'Hi ive been having issues with my pc randomly crashing when either waking it up or in a middle of the game',
    url: 'https://windowsforum.com/windows-help-and-support.302/pc-issues-restart-freeze-sound-on-but-keyboard-and-monitor-frozen.263552/',
    section: 'threads',
    source: 'bm25'
  },
  {
    id: 'post-836348',
    title: 'Periodical BSOD Windows 11 fresh install (Windows 10 before BSOD too)',
    text: 'Last BSOD in WinDbg -- DPC_WATCHDOG_VIOLATION (133) The DPC watchdog detected a prolonged run time at an IRQL of DISPATCH_LEVEL or above.',
    url: 'https://windowsforum.com/windows-blue-screen-of-death-bsod.307/periodical-bsod-windows-11-fresh-install-windows-10-before-bsod-too.335403/',
    section: 'threads',
    source: 'semantic',
    score: 0.87
  },
  {
    id: 'thread-338855',
    title: 'Help Deciphering DPC_WATCHDOG_VIOLATION Error After System Crash',
    text: 'Attached is the error I believe that caused my crash, can anyone decipher what this means. 14: kd> !analyze -v',
    url: 'https://windowsforum.com/windows-blue-screen-of-death-bsod.307/help-deciphering-dpc_watchdog_violation-error-after-system-crash.338855/',
    section: 'threads',
    source: 'semantic',
    score: 0.85
  },
  {
    id: 'post-843666',
    title: 'Help Deciphering DPC_WATCHDOG_VIOLATION Error After System Crash',
    text: 'Hello Morrison1995, it seems you experienced a DPC_WATCHDOG_VIOLATION (Bugcheck 0x133).',
    url: 'https://windowsforum.com/windows-blue-screen-of-death-bsod.307/help-deciphering-dpc_watchdog_violation-error-after-system-crash.338855/',
    section: 'threads',
    source: 'semantic',
    score: 0.84
  },
  {
    id: 'thread-200625',
    title: 'STOP: 0x00000116 nvlddkm.sys',
    text: 'After that I got the 0x00000124 blue screen',
    url: 'https://windowsforum.com/windows-blue-screen-of-death-bsod.307/stop-0x00000116-nvlddkm-sys.200625/',
    section: 'threads',
    source: 'semantic',
    score: 0.84
  },
  {
    id: 'thread-400001',
    title: 'Game crashes: DPC_WATCHDOG_VIOLATION after NVIDIA update',
    text: 'WinDbg blames nvlddmkm.sys every time.',
    url: 'https://windowsforum.com/windows-11.1/game-crashes.400001/',
    section: 'threads',
    source: 'bm25'
  },
  {
    id: 'thread-400002',
    title: 'NVIDIA hotfix driver fixes nvlddmkm crashes',
    text: 'The hotfix addresses nvlddmkm.sys timeouts.',
    url: 'https://evil.example/phish',
    section: 'news',
    source: 'semantic'
  }
];

function sseBody(id, structuredContent) {
  const log = { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: { msg: 'Searching' } } };
  const result = { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], isError: false, structuredContent } };
  return `event: message\ndata: ${JSON.stringify(log)}\n\nevent: message\ndata: ${JSON.stringify(result)}\n\n`;
}

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const request = JSON.parse(init.body);
    calls.push({ url, init, request });
    return handler(request, calls.length);
  };
  return { calls, fetchImpl };
}

function response(status, body, type = 'text/event-stream') {
  return new Response(body, { status, headers: { 'content-type': type } });
}

test('parseSseMessages reads every data event and skips malformed ones', () => {
  const messages = parseSseMessages('event: message\ndata: {"a":1}\n\nevent: message\ndata: not json\n\ndata: {"b":\ndata: 2}\n\n');
  assert.deepEqual(messages, [{ a: 1 }, { b: 2 }]);
});

test('MCP client posts a tools/call and returns structured content from SSE', async () => {
  const { calls, fetchImpl } = fakeFetch(request => response(200, sseBody(request.id, { results: LIVE_RESULTS })));
  const client = createForumMcpClient({ url: 'https://mcp.test/', fetchImpl });
  const data = await client.callTool('search', { query: 'x' });
  assert.equal(data.results.length, LIVE_RESULTS.length);
  assert.equal(calls[0].url, 'https://mcp.test/');
  assert.equal(calls[0].request.method, 'tools/call');
  assert.deepEqual(calls[0].request.params, { name: 'search', arguments: { query: 'x' } });
  assert.match(calls[0].init.headers.Accept, /text\/event-stream/);
  assert.ok(calls[0].init.signal);
});

test('MCP client accepts plain JSON and falls back to text content', async () => {
  const { fetchImpl } = fakeFetch(request => response(200, JSON.stringify({
    jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: '{"results":[]}' }] }
  }), 'application/json'));
  const client = createForumMcpClient({ fetchImpl });
  assert.deepEqual(await client.callTool('search', {}), { results: [] });
});

test('MCP client throws on HTTP, JSON-RPC and tool errors', async () => {
  const cases = [
    () => response(503, 'down', 'text/plain'),
    request => response(200, `data: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'bad' } })}\n\n`),
    request => response(200, `data: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { isError: true, content: [{ type: 'text', text: 'boom' }] } })}\n\n`),
    () => response(200, `data: ${JSON.stringify({ jsonrpc: '2.0', id: 999, result: {} })}\n\n`)
  ];
  for (const handler of cases) {
    const client = createForumMcpClient({ fetchImpl: fakeFetch(handler).fetchImpl });
    await assert.rejects(client.callTool('search', {}));
  }
});

test('keys: stop codes and labels normalize, generic and pseudo modules are dropped', () => {
  assert.deepEqual(normalizeRelatedKeys({ code: '0x00000133', name: 'DPC_WATCHDOG_VIOLATION', module: 'NVLDDMKM.SYS' }), KEYS);
  assert.deepEqual(normalizeRelatedKeys({ code: '0x1a', module: 'ntoskrnl.exe' }), { code: '0x1A', name: null, module: null });
  assert.deepEqual(normalizeRelatedKeys({ module: 'rtwlane.sys' }), { code: null, name: null, module: 'rtwlane.sys' });
  assert.equal(normalizeRelatedKeys({ module: 'memory_corruption' }), null);
  assert.equal(normalizeRelatedKeys({ code: 'not a code', module: 'nt!KiPageFault' }), null);
  assert.equal(normalizeRelatedKeys({ code: '0x133', name: '<script>' }).name, null);
  assert.equal(normalizeRelatedKeys({ code: '0x00000000' }), null);
  assert.equal(normalizeRelatedKeys({ code: '0x1234567890' }), null);
  assert.equal(normalizeRelatedKeys({ code: '0xDEADBEEF' }).code, '0xDEADBEEF');
  assert.deepEqual(normalizeRelatedKeys(normalizeRelatedKeys(KEYS)), KEYS);
});

test('keys for a WinDBG analysis come from the structured signal', () => {
  const keys = relatedKeysForAnalysis({
    structured: { bugcheck: { code: '0x00000133', name: 'DPC_WATCHDOG_VIOLATION' }, crash: { imageName: 'nvlddmkm.sys' } },
    report: { culprit: 'something else' }
  });
  assert.deepEqual(keys, KEYS);
  assert.equal(relatedKeysForAnalysis({ structured: {}, report: {} }), null);
});

test('query uses only the available keys', () => {
  assert.equal(buildRelatedQuery(KEYS), 'DPC_WATCHDOG_VIOLATION 0x133 nvlddmkm.sys');
  assert.equal(buildRelatedQuery({ code: '0x1A', name: null, module: null }), '0x1A BSOD');
});

test('ranking dedupes posts into threads, drops off-topic hits, and orders by match strength', () => {
  const threads = rankRelatedResults(LIVE_RESULTS, KEYS, 10);
  assert.deepEqual(threads.map(t => [t.threadId, t.match]), [
    [400001, 'code+module'],
    [400002, 'module'],
    [335403, 'code'],
    [338855, 'code']
  ]);
  // Unrelated BM25 hit and a different stop code with a misspelled driver are gone.
  assert.ok(!threads.some(t => t.threadId === 263552 || t.threadId === 200625));
  // A non-forum URL is never passed through.
  assert.equal(threads[1].url, 'https://windowsforum.com/threads/400002/');
  assert.equal(threads[1].kind, 'news');
  // Thread 338855 appeared as a thread and a post; the thread row wins.
  assert.equal(threads.filter(t => t.threadId === 338855).length, 1);
});

test('ranking prefers the BSOD board among equal matches and trims long text', () => {
  const long = 'DPC_WATCHDOG_VIOLATION ' + 'word '.repeat(100);
  const threads = rankRelatedResults([
    { id: 'thread-1', title: 'Elsewhere 0x133', text: long, url: 'https://windowsforum.com/windows-10.2/a.1/' },
    { id: 'thread-2', title: 'On the board 0x133', text: '[*]  short   text ****', url: 'https://windowsforum.com/windows-blue-screen-of-death-bsod.307/b.2/' }
  ], { code: '0x133', name: null, module: null });
  assert.deepEqual(threads.map(t => t.threadId), [2, 1]);
  assert.equal(threads[0].snippet, 'short text');
  assert.ok(threads[1].snippet.length <= 181);
  assert.ok(threads[1].snippet.endsWith('…'));
});

test('short stop codes only match in 0x form, not stray "(a)" text', () => {
  const threads = rankRelatedResults([
    { id: 'thread-1', title: 'Steps (a) and (b)', text: 'nothing here', url: 'https://windowsforum.com/x.1/' },
    { id: 'thread-2', title: 'Stop 0x0000000A', text: '', url: 'https://windowsforum.com/x.2/' }
  ], { code: '0xA', name: null, module: null });
  assert.deepEqual(threads.map(t => t.threadId), [2]);
});

function serviceHarness({ handler, ...options } = {}) {
  let clock = 1_000_000;
  const warnings = [];
  const fetch = fakeFetch(handler || (request => response(200, sseBody(request.id, { results: LIVE_RESULTS }))));
  const service = createForumRelatedService({
    client: createForumMcpClient({ fetchImpl: fetch.fetchImpl }),
    now: () => clock,
    logger: { warn: (...args) => warnings.push(args) },
    ...options
  });
  return { service, fetch, warnings, tick: ms => { clock += ms; } };
}

test('service caches per key and shares one in-flight search', async () => {
  const { service, fetch, tick } = serviceHarness();
  const [a, b] = await Promise.all([service.find(KEYS), service.find({ ...KEYS, code: '0x00000133' })]);
  assert.equal(a.available, true);
  assert.equal(a.threads.length, 4);
  assert.deepEqual(a.threads, b.threads);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].request.params.arguments.query, 'DPC_WATCHDOG_VIOLATION 0x133 nvlddmkm.sys');

  assert.equal((await service.find(KEYS)).cached, true);
  assert.equal(fetch.calls.length, 1);
  tick(13 * 60 * 60 * 1000);
  await service.find(KEYS);
  assert.equal(fetch.calls.length, 2);
});

test('service caches empty results for a shorter time', async () => {
  const { service, fetch, tick } = serviceHarness({ handler: request => response(200, sseBody(request.id, { results: [] })) });
  assert.deepEqual(await service.find(KEYS), { available: true, threads: [] });
  tick(29 * 60 * 1000);
  await service.find(KEYS);
  assert.equal(fetch.calls.length, 1);
  tick(2 * 60 * 1000);
  await service.find(KEYS);
  assert.equal(fetch.calls.length, 2);
});

test('service fails open, serves stale results, and opens a breaker after repeated failures', async () => {
  let fail = false;
  const { service, fetch, warnings, tick } = serviceHarness({
    handler: request => (fail ? response(502, 'bad gateway', 'text/plain') : response(200, sseBody(request.id, { results: LIVE_RESULTS })))
  });
  await service.find(KEYS);
  fail = true;
  tick(13 * 60 * 60 * 1000);
  const stale = await service.find(KEYS);
  assert.equal(stale.available, true);
  assert.equal(stale.stale, true);
  assert.equal(stale.threads.length, 4);

  // Two more distinct failures trip the breaker (threshold 3).
  assert.deepEqual(await service.find({ code: '0x1A' }), { available: false, threads: [] });
  assert.deepEqual(await service.find({ code: '0x50' }), { available: false, threads: [] });
  const callsWhenOpen = fetch.calls.length;
  assert.deepEqual(await service.find({ code: '0x7E' }), { available: false, threads: [] });
  assert.equal(fetch.calls.length, callsWhenOpen);
  assert.equal(warnings.length, 3);

  fail = false;
  tick(61 * 1000);
  assert.equal((await service.find({ code: '0x7E' })).available, true);
});

test('service is a no-op when disabled or given unusable keys', async () => {
  const disabled = serviceHarness({ isEnabled: () => false });
  assert.deepEqual(await disabled.service.find(KEYS), { available: false, threads: [] });
  assert.equal(disabled.fetch.calls.length, 0);

  const { service, fetch } = serviceHarness();
  assert.deepEqual(await service.find({ module: 'ntoskrnl.exe' }), { available: false, threads: [] });
  assert.deepEqual(await service.findForAnalysis({ structured: {}, report: {} }), []);
  assert.equal(fetch.calls.length, 0);
});

test('service evicts the oldest entries past the cap and prunes long-expired ones', async () => {
  const { service, fetch, tick } = serviceHarness({ maxEntries: 2 });
  await service.find({ code: '0x1' });
  await service.find({ code: '0x2' });
  await service.find({ code: '0x3' });
  await service.find({ code: '0x3' });
  assert.equal(fetch.calls.length, 3);
  await service.find({ code: '0x1' }); // evicted, fetched again
  assert.equal(fetch.calls.length, 4);

  tick(25 * 60 * 60 * 1000);
  service.prune();
  await service.find({ code: '0x1' });
  assert.equal(fetch.calls.length, 5);
});

async function listen(app) {
  await new Promise(resolve => app.listen(0, resolve));
  const address = app.fastify.server.address();
  return { port: address.port, close: () => app.fastify.close() };
}

test('GET /api/forum/related validates keys and returns campaign-tagged forum links', async () => {
  const { service } = serviceHarness();
  const app = createFastifyCompatApp({ bodyLimit: 1024 });
  let guarded = 0;
  const guard = (_req, _res, next) => { guarded += 1; next(); };
  registerForumRelatedRoute(app, { service, middlewares: [guard] });
  const server = await listen(app);
  try {
    const bad = await fetch(`http://127.0.0.1:${server.port}/api/forum/related?module=ntoskrnl.exe`);
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, 'INVALID_QUERY');

    const ok = await fetch(`http://127.0.0.1:${server.port}/api/forum/related?code=0x133&name=DPC_WATCHDOG_VIOLATION&module=nvlddmkm.sys`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'private, max-age=900');
    const body = await ok.json();
    assert.equal(body.available, true);
    assert.deepEqual(body.query, KEYS);
    assert.equal(body.threads.length, 4);
    assert.match(body.threads[0].url, /^https:\/\/windowsforum\.com\/.*utm_source=bsod\.windowsforum\.com/);
    assert.match(body.boardUrl, /windows-blue-screen-of-death-bsod\.307/);
    assert.equal(guarded, 2);
  } finally {
    await server.close();
  }
});

test('cleaning forum results stays linear on a long unclosed "<" run (issue #152)', () => {
  const run = '<'.repeat(1_000_000);
  const started = performance.now();
  const threads = rankRelatedResults([
    { id: 'thread-1', title: `Stop 0x133 ${run}`, text: `<b>0x133</b> in nvlddmkm ${run}`, url: 'https://windowsforum.com/x.1/' }
  ], KEYS);
  assert.ok(performance.now() - started < 500, 'an unclosed "<" run must not backtrack quadratically');
  assert.equal(threads.length, 1);
  // Tags are still stripped; the "<" run is cut to the field cap, then truncated for display.
  assert.ok(threads[0].snippet.startsWith('0x133 in nvlddmkm <<<'));
  assert.ok(threads[0].snippet.length <= 181);
});
