import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UpstashBinaryError,
  createUpstashBinaryClient,
  parseResp2BulkString,
} from '../services/upstashBinary.js';

function respBulk(payload) {
  const value = Buffer.from(payload);
  return Buffer.concat([Buffer.from(`$${value.length}\r\n`), value, Buffer.from('\r\n')]);
}

test('parseResp2BulkString preserves arbitrary binary bytes', () => {
  const payload = Buffer.from([0x00, 0xff, 0x28, 0xb5, 0x2f, 0xfd]);
  assert.deepEqual(parseResp2BulkString(respBulk(payload)), payload);
  assert.equal(parseResp2BulkString(Buffer.from('$-1\r\n')), null);
});

test('parseResp2BulkString rejects errors and malformed lengths', () => {
  assert.throws(
    () => parseResp2BulkString(Buffer.from('-ERR nope\r\n')),
    error => error instanceof UpstashBinaryError && /ERR nope/.test(error.message),
  );
  assert.throws(() => parseResp2BulkString(Buffer.from('$4\r\nabc\r\n')), /length/);
  assert.throws(() => parseResp2BulkString(Buffer.from('+OK\r\n')), /bulk-string/);
});

test('binary client sends compressed bytes directly and receives RESP2 bytes', async () => {
  const calls = [];
  const stored = Buffer.from([0x42, 0x53, 0x4f, 0x44, 0x00, 0xff]);
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (init.method === 'POST') {
      return new Response(JSON.stringify({ result: 'OK' }), {
        status: 200,
        headers: { 'upstash-sync-token': 'write-token' },
      });
    }
    return new Response(respBulk(stored), {
      status: 200,
      headers: { 'upstash-sync-token': 'read-token' },
    });
  };
  const client = createUpstashBinaryClient({
    url: 'https://example.upstash.io/',
    token: 'secret',
    fetchImpl,
    retries: 0,
  });

  await client.set('analysis:abc', stored, { ex: 604800 });
  const loaded = await client.get('analysis:abc');

  assert.deepEqual(loaded, stored);
  assert.match(calls[0].url, /\/set\/analysis%3Aabc\?EX=604800$/);
  assert.deepEqual(Buffer.from(calls[0].init.body), stored);
  assert.equal(calls[0].init.headers.get('content-type'), 'application/octet-stream');
  assert.equal(calls[1].init.headers.get('upstash-response-format'), 'resp2');
  assert.equal(calls[1].init.headers.get('upstash-sync-token'), 'write-token');
  assert.equal(client.getSyncToken(), 'read-token');
});

test('binary client retries network failures without retrying command errors', async () => {
  let attempts = 0;
  const client = createUpstashBinaryClient({
    url: 'https://example.upstash.io',
    token: 'secret',
    retries: 2,
    backoff: () => 0,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('temporary network failure');
      return new Response('$-1\r\n', { status: 200 });
    },
  });
  assert.equal(await client.get('analysis:abc'), null);
  assert.equal(attempts, 3);

  const failing = createUpstashBinaryClient({
    url: 'https://example.upstash.io',
    token: 'secret',
    retries: 3,
    fetchImpl: async () => new Response(JSON.stringify({ error: 'bad command' }), { status: 400 }),
  });
  await assert.rejects(() => failing.get('analysis:abc'), /bad command/);
});

test('binary client stores immutable registry bytes with SETNX', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ result: calls.length === 1 ? 1 : 0 }), { status: 200 });
  };
  const client = createUpstashBinaryClient({
    url: 'https://example.upstash.io',
    token: 'secret',
    fetchImpl,
    retries: 0,
  });
  const dictionary = Buffer.from([0x00, 0xff, 0x01]);

  assert.equal(await client.setNx('cachemeta:zstd:dictionary:abc', dictionary), true);
  assert.equal(await client.setNx('cachemeta:zstd:dictionary:abc', dictionary), false);
  assert.match(calls[0].url, /\/setnx\/cachemeta%3Azstd%3Adictionary%3Aabc$/);
  assert.deepEqual(Buffer.from(calls[0].init.body), dictionary);
});

test('binary client does not regress its sync token when requests finish out of order', async () => {
  const pending = [];
  const client = createUpstashBinaryClient({
    url: 'https://example.upstash.io',
    token: 'secret',
    retries: 0,
    fetchImpl: () => new Promise(resolve => pending.push(resolve)),
  });

  const first = client.get('analysis:first');
  const second = client.get('analysis:second');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2);

  pending[1](new Response('$-1\r\n', {
    status: 200,
    headers: { 'upstash-sync-token': 'newer-token' },
  }));
  await second;
  pending[0](new Response('$-1\r\n', {
    status: 200,
    headers: { 'upstash-sync-token': 'older-token' },
  }));
  await first;

  assert.equal(client.getSyncToken(), 'newer-token');
});

test('binary client retries transient HTTP 429/5xx and honors Retry-After', async () => {
  const delays = [];
  const statuses = [503, 429];
  let calls = 0;
  const client = createUpstashBinaryClient({
    url: 'https://example.upstash.io',
    token: 'secret',
    retries: 2,
    backoff: () => 0,
    delayImpl: ms => {
      delays.push(ms);
      return Promise.resolve();
    },
    fetchImpl: async () => {
      const status = statuses[calls] ?? 200;
      calls += 1;
      if (status !== 200) {
        return new Response(JSON.stringify({ error: 'rate limited' }), {
          status,
          headers: { 'retry-after': '1' },
        });
      }
      return new Response('$-1\r\n', { status: 200 });
    },
  });

  assert.equal(await client.get('analysis:abc'), null);
  assert.equal(calls, 3);
  // Retry-After (capped to 5s) takes precedence over the exponential backoff.
  assert.deepEqual(delays, [1000, 1000]);
});

test('binary client fails fast on non-retryable HTTP statuses', async () => {
  let calls = 0;
  const client = createUpstashBinaryClient({
    url: 'https://example.upstash.io',
    token: 'secret',
    retries: 3,
    backoff: () => 0,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    },
  });

  await assert.rejects(() => client.get('analysis:abc'), /unauthorized/);
  assert.equal(calls, 1);
});

test('binary client deletes keys and reports whether anything was removed', async () => {
  const calls = [];
  const client = createUpstashBinaryClient({
    url: 'https://example.upstash.io',
    token: 'secret',
    retries: 0,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init.method });
      return new Response(JSON.stringify({ result: calls.length === 1 ? 1 : 0 }), { status: 200 });
    },
  });

  assert.equal(await client.del('cachemeta:zstd:dictionary:abc'), true);
  assert.equal(await client.del('cachemeta:zstd:dictionary:abc'), false);
  assert.match(calls[0].url, /\/del\/cachemeta%3Azstd%3Adictionary%3Aabc$/);
});
