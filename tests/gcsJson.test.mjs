import test from 'node:test';
import assert from 'node:assert/strict';
import { createGcsJsonReader, parseNdjson } from '../server/gcsJson.js';

function storage(objects) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const path = decodeURIComponent(url.split('/o/')[1].split('?')[0]);
    const obj = objects[path];
    if (!obj || obj.fail) return { ok: false, status: obj?.fail || 404, json: async () => ({}), text: async () => '' };
    if (url.includes('fields=generation')) return { ok: true, status: 200, json: async () => ({ generation: obj.generation }) };
    return { ok: true, status: 200, text: async () => obj.body };
  };
  return { calls, fetchImpl };
}

test('parseNdjson reads EXPORT DATA json lines', () => {
  assert.deepEqual(parseNdjson('{"a":1}\n\n{"a":2}\n'), [{ a: 1 }, { a: 2 }]);
});

test('reads once, serves from memory between checks, re-downloads only on a new generation', async () => {
  const objects = { 'live/x.json': { generation: '1', body: '{"n":1}\n' } };
  const { calls, fetchImpl } = storage(objects);
  let clock = 0;
  const reader = createGcsJsonReader({ bucket: 'b', getAccessToken: async () => 't', fetchImpl, checkIntervalMs: 1000, now: () => clock });

  assert.deepEqual(await reader.read('live/x.json'), [{ n: 1 }]);
  assert.equal(calls.length, 2); // metadata + media
  assert.deepEqual(await reader.read('live/x.json'), [{ n: 1 }]);
  assert.equal(calls.length, 2); // cached, no network

  clock = 1500; // interval passed, same generation: metadata only
  await reader.read('live/x.json');
  assert.equal(calls.length, 3);

  clock = 3000;
  objects['live/x.json'] = { generation: '2', body: '{"n":2}\n' };
  assert.deepEqual(await reader.read('live/x.json'), [{ n: 2 }]);
  assert.equal(calls.length, 5);
  assert.match(calls[4], /ifGenerationMatch=2/);
});

test('a failed refresh keeps serving the cached copy; nothing cached rethrows', async () => {
  const objects = { 'a.json': { generation: '1', body: '{"ok":true}' } };
  const { fetchImpl } = storage(objects);
  let clock = 0;
  const reader = createGcsJsonReader({ bucket: 'b', getAccessToken: async () => 't', fetchImpl, checkIntervalMs: 10, now: () => clock });
  await reader.read('a.json');
  objects['a.json'].fail = 503;
  clock = 100;
  assert.deepEqual(await reader.read('a.json'), [{ ok: true }]);
  await assert.rejects(reader.read('missing.json'), /HTTP 404/);
});

test('concurrent readers share one fetch', async () => {
  const { calls, fetchImpl } = storage({ 'c.json': { generation: '1', body: '{"c":1}' } });
  const reader = createGcsJsonReader({ bucket: 'b', getAccessToken: async () => 't', fetchImpl });
  const [a, b] = await Promise.all([reader.read('c.json'), reader.read('c.json')]);
  assert.deepEqual(a, b);
  assert.equal(calls.length, 2);
});
