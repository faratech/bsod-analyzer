import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createFastifyCompatApp, staticMiddleware, staticNotModified } from '../server/fastifyCompat.js';

// Issue #356: staticMiddleware set ETag/Last-Modified but never answered a
// revalidation with 304, so the daily revalidation of unhashed root files
// (#348) re-downloaded every body in full, and Range was silently ignored.

const BODY = Buffer.alloc(4096, 0x61);

async function setup(t, { compression = { enabled: true, threshold: 1, forceThreshold: 0 } } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bsod-static-cond-'));
  await fs.writeFile(path.join(root, 'og-image.webp'), BODY);
  await fs.writeFile(path.join(root, 'robots.txt'), 'User-agent: *\n'.repeat(200));
  // Fixed mtime with a sub-second part, as on real filesystems.
  const mtime = new Date('2026-10-01T12:00:00.750Z');
  await fs.utimes(path.join(root, 'og-image.webp'), mtime, mtime);
  await fs.utimes(path.join(root, 'robots.txt'), mtime, mtime);

  const app = createFastifyCompatApp({ compression });
  app.use(staticMiddleware(root, {
    maxAge: '1y',
    setHeaders: (res, filePath) => {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Vary', 'Origin');
      if (filePath.endsWith('.txt')) res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      else res.setHeader('Content-Type', 'image/webp');
    }
  }));
  app.use((req, res) => res.status(404).send('not found'));
  t.after(async () => {
    await app.fastify.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const first = await app.fastify.inject({ method: 'GET', url: '/og-image.webp' });
  assert.equal(first.statusCode, 200);
  return { app, etag: first.headers.etag, lastModified: first.headers['last-modified'], mtime };
}

function assertNotModified(res, etag, lastModified) {
  assert.equal(res.statusCode, 304);
  assert.equal(res.rawPayload.length, 0);
  assert.equal(res.headers.etag, etag);
  assert.equal(res.headers['last-modified'], lastModified);
  assert.equal(res.headers['cache-control'], 'public, max-age=86400');
  assert.equal(res.headers.vary, 'Origin');
  assert.equal(res.headers['content-length'], undefined);
}

test('a matching If-None-Match answers 304 with validators and no body (GET and HEAD)', async (t) => {
  const { app, etag, lastModified } = await setup(t);
  assert.match(etag, /^W\/"/);
  for (const method of ['GET', 'HEAD']) {
    for (const inm of [
      etag,
      etag.slice(2), // strong form of the same tag: weak comparison matches
      `"other", ${etag}`,
      `"a",${etag} , "b"`,
      '*'
    ]) {
      const res = await app.fastify.inject({ method, url: '/og-image.webp', headers: { 'if-none-match': inm } });
      assertNotModified(res, etag, lastModified);
    }
  }
});

test('a non-matching If-None-Match serves the full body and wins over If-Modified-Since', async (t) => {
  const { app, etag } = await setup(t);
  const res = await app.fastify.inject({
    method: 'GET',
    url: '/og-image.webp',
    headers: {
      'if-none-match': 'W/"0-0", "nope"',
      'if-modified-since': new Date(Date.now() + 86400000).toUTCString()
    }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.rawPayload.length, BODY.length);
  assert.equal(res.headers.etag, etag);
});

test('If-Modified-Since compares against the mtime truncated to whole seconds', async (t) => {
  const { app, etag, lastModified, mtime } = await setup(t);
  assert.equal(lastModified, 'Thu, 01 Oct 2026 12:00:00 GMT');

  for (const ims of [lastModified, new Date(mtime.getTime() + 5000).toUTCString()]) {
    for (const method of ['GET', 'HEAD']) {
      const res = await app.fastify.inject({ method, url: '/og-image.webp', headers: { 'if-modified-since': ims } });
      assertNotModified(res, etag, lastModified);
    }
  }
  for (const ims of [new Date(mtime.getTime() - 1000).toUTCString(), 'not a date', '']) {
    const res = await app.fastify.inject({ method: 'GET', url: '/og-image.webp', headers: { 'if-modified-since': ims } });
    assert.equal(res.statusCode, 200, ims);
    assert.equal(res.rawPayload.length, BODY.length, ims);
  }
});

test('Range is not supported: full 200 with Accept-Ranges: none', async (t) => {
  const { app } = await setup(t);
  for (const method of ['GET', 'HEAD']) {
    const res = await app.fastify.inject({ method, url: '/og-image.webp', headers: { range: 'bytes=0-10' } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['accept-ranges'], 'none');
    assert.equal(res.headers['content-range'], undefined);
    assert.equal(res.rawPayload.length, method === 'GET' ? BODY.length : 0);
  }
});

test('the weak ETag revalidates whatever Accept-Encoding the client sends', async (t) => {
  const { app } = await setup(t);
  const plain = await app.fastify.inject({ method: 'GET', url: '/robots.txt' });
  const encoded = await app.fastify.inject({ method: 'GET', url: '/robots.txt', headers: { 'accept-encoding': 'gzip, br, zstd' } });
  assert.equal(plain.statusCode, 200);
  assert.equal(encoded.statusCode, 200);
  assert.equal(encoded.headers.etag, plain.headers.etag);
  for (const ae of ['gzip, br, zstd', 'identity', undefined]) {
    const headers = { 'if-none-match': encoded.headers.etag };
    if (ae) headers['accept-encoding'] = ae;
    const res = await app.fastify.inject({ method: 'GET', url: '/robots.txt', headers });
    assert.equal(res.statusCode, 304, String(ae));
    assert.equal(res.headers['content-encoding'], undefined);
    assert.equal(res.rawPayload.length, 0);
  }
});

test('staticNotModified follows RFC 9110 precedence', () => {
  const etag = 'W/"1000-abc"';
  const mtimeMs = Date.parse('2026-10-01T12:00:00.750Z');
  assert.equal(staticNotModified({}, etag, mtimeMs), false);
  assert.equal(staticNotModified({ 'if-none-match': 'W/"1000-abd"' }, etag, mtimeMs), false);
  assert.equal(staticNotModified({ 'if-none-match': '"1000-abc"' }, etag, mtimeMs), true);
  assert.equal(staticNotModified({ 'if-none-match': ' * ' }, etag, mtimeMs), true);
  // A tag containing a comma is not split apart.
  assert.equal(staticNotModified({ 'if-none-match': '"1000-abc,x"' }, etag, mtimeMs), false);
  assert.equal(staticNotModified({ 'if-modified-since': 'Thu, 01 Oct 2026 12:00:00 GMT' }, etag, mtimeMs), true);
  assert.equal(staticNotModified({ 'if-modified-since': 'Thu, 01 Oct 2026 11:59:59 GMT' }, etag, mtimeMs), false);
  // If-None-Match present: If-Modified-Since is ignored.
  assert.equal(staticNotModified({
    'if-none-match': '"x"',
    'if-modified-since': 'Thu, 01 Oct 2026 13:00:00 GMT'
  }, etag, mtimeMs), false);
});

// Issue #366: Date.parse accepted values that are not HTTP-dates ("9999" is
// the year 9999), answering 304 for them. RFC 9110 13.1.3: a recipient MUST
// ignore an If-Modified-Since that is not a valid HTTP-date.
test('If-Modified-Since is honoured only as an HTTP-date (issue #366)', async () => {
  const { parseHttpDate } = await import('../server/fastifyCompat.js');
  const expected = Date.UTC(1994, 10, 6, 8, 49, 37);
  assert.equal(parseHttpDate('Sun, 06 Nov 1994 08:49:37 GMT'), expected, 'IMF-fixdate');
  assert.equal(parseHttpDate('Sunday, 06-Nov-94 08:49:37 GMT'), expected, 'RFC 850');
  assert.equal(parseHttpDate('Sun Nov  6 08:49:37 1994'), expected, 'asctime');
  assert.equal(parseHttpDate('Sun Nov 16 08:49:37 1994'), Date.UTC(1994, 10, 16, 8, 49, 37), 'asctime, two-digit day');
  assert.equal(parseHttpDate(' Thu, 01 Oct 2026 12:00:00 GMT '), Date.UTC(2026, 9, 1, 12), 'surrounding whitespace');
  // RFC 850 two-digit years: more than 50 years ahead means the past century.
  const nextYear = (new Date().getUTCFullYear() + 1) % 100;
  assert.equal(new Date(parseHttpDate(`Friday, 01-Jan-${String(nextYear).padStart(2, '0')} 00:00:00 GMT`)).getUTCFullYear(), new Date().getUTCFullYear() + 1);
  for (const invalid of [
    '9999', '2030', '2026-10-01', '2026-10-01T12:00:00Z', 'Oct 1 2099', 'Thu, 01 Oct 2026 12:00:00',
    'Thu, 01 Oct 2026 12:00:00 +0000', 'Thu, 1 Oct 2026 12:00:00 GMT', 'thu, 01 oct 2026 12:00:00 gmt',
    'Thu, 32 Oct 2026 12:00:00 GMT', 'Thu, 31 Feb 2026 12:00:00 GMT', 'Thu, 01 Oct 2026 24:00:00 GMT',
    'Thu, 01 Oct 2026 12:60:00 GMT', 'Thu, 01 Foo 2026 12:00:00 GMT', 'Xyz, 01 Oct 2026 12:00:00 GMT',
    'Sunday, 06-Nov-1994 08:49:37 GMT', 'Sun Nov 6 08:49:37 1994', '', 'garbage',
  ]) {
    assert.equal(parseHttpDate(invalid), null, invalid);
  }
  const etag = 'W/"1000-abc"';
  const mtimeMs = Date.parse('2026-10-01T12:00:00.750Z');
  for (const value of ['9999', '2030', 'Oct 1 2099', '2099-01-01']) {
    assert.equal(staticNotModified({ 'if-modified-since': value }, etag, mtimeMs), false, value);
  }
  assert.equal(staticNotModified({ 'if-modified-since': 'Friday, 01-Jan-27 00:00:00 GMT' }, etag, mtimeMs), true);
  assert.equal(staticNotModified({ 'if-modified-since': 'Thu Oct  1 12:00:00 2026' }, etag, mtimeMs), true);
});
