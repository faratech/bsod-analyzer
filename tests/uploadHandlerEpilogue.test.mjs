// A multipart body whose bytes after the closing boundary (the epilogue)
// arrive in a later read must not hang upload.single(): busboy never settles
// the part iterator then, and the route concurrency slot is held until the
// handler chain settles (#313).
import test from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import net from 'node:net';
import fastifyMultipart from '@fastify/multipart';
import { createFastifyCompatApp } from '../server/fastifyCompat.js';
import { createUploadHandler } from '../server/uploadHandler.js';
import { createConcurrencyLimiter } from '../server/concurrency.js';

const BOUNDARY = 'XBOUND';
const UID = 'b'.repeat(64);
const HEAD = Buffer.from(
  `--${BOUNDARY}\r\nContent-Disposition: form-data; name="uid"\r\n\r\n${UID}\r\n` +
  `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.dmp"\r\n\r\nMDMPxxxx\r\n--${BOUNDARY}--\r\n`
);
const EPILOGUE = Buffer.alloc(4096, 0x41);

async function startApp(t, { http2: useH2 = false } = {}) {
  const app = createFastifyCompatApp(useH2 ? { http2: true } : {});
  app.fastify.register(fastifyMultipart, { limits: { fileSize: 1e8, files: 1, fields: 20, parts: 25 } });
  const upload = createUploadHandler({
    limits: { fileSize: 1e8, files: 1 },
    fileFilter: (_req, _file, cb) => cb(null, true)
  });
  const limiter = createConcurrencyLimiter(1, 'BUSY');
  app.post('/up', limiter, upload.single('file'), (req, res) => {
    res.json({ uid: req.body?.uid ?? null, size: req.file?.size ?? null });
  });
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  const sockets = new Set();
  app.fastify.server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  app.fastify.server.on('session', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  // A hung request must fail the test, not hang the runner in close().
  t.after(() => {
    for (const s of sockets) s.destroy();
    return app.fastify.close();
  });
  return { port: app.fastify.server.address().port, limiter };
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: no response within ${ms} ms`)), ms); })
  ]).finally(() => clearTimeout(timer));
}

function http1Request(port, { chunked }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', async () => {
      socket.setNoDelay(true);
      const framing = chunked
        ? 'Transfer-Encoding: chunked'
        : `Content-Length: ${HEAD.length + EPILOGUE.length}`;
      socket.write(`POST /up HTTP/1.1\r\nHost: x\r\nContent-Type: multipart/form-data; boundary=${BOUNDARY}\r\n${framing}\r\nConnection: close\r\n\r\n`);
      const frame = buf => chunked ? Buffer.concat([Buffer.from(buf.length.toString(16) + '\r\n'), buf, Buffer.from('\r\n')]) : buf;
      socket.write(frame(HEAD));
      await new Promise(r => setTimeout(r, 100));
      socket.write(frame(EPILOGUE));
      if (chunked) socket.write('0\r\n\r\n');
    });
    let out = '';
    socket.on('data', d => { out += d; });
    socket.on('end', () => resolve(out));
    socket.on('error', reject);
  });
}

async function waitForRelease(limiter) {
  for (let i = 0; i < 50 && limiter.inFlight() !== 0; i++) await new Promise(r => setTimeout(r, 20));
  return limiter.inFlight();
}

for (const chunked of [false, true]) {
  test(`upload.single settles when the epilogue arrives in a later read (HTTP/1.1, ${chunked ? 'chunked' : 'Content-Length'})`, async (t) => {
    const { port, limiter } = await startApp(t);
    const raw = await withTimeout(http1Request(port, { chunked }), 5000, 'epilogue request');
    assert.match(raw, /^HTTP\/1\.1 200/);
    assert.deepEqual(JSON.parse(raw.split('\r\n\r\n').pop()), { uid: UID, size: 8 });
    assert.equal(await waitForRelease(limiter), 0, 'concurrency slot released');

    // The slot is usable again: a well-formed upload is admitted.
    const again = await withTimeout(http1Request(port, { chunked }), 5000, 'second request');
    assert.match(again, /^HTTP\/1\.1 200/);
    assert.equal(await waitForRelease(limiter), 0);
  });
}

test('upload.single settles when the epilogue arrives in a later read (h2c)', async (t) => {
  const { port, limiter } = await startApp(t, { http2: true });
  const client = http2.connect(`http://127.0.0.1:${port}`);
  t.after(() => client.destroy());
  for (let i = 0; i < 2; i++) {
    const req = client.request({
      ':method': 'POST',
      ':path': '/up',
      'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      'content-length': HEAD.length + EPILOGUE.length
    });
    let out = '';
    let status;
    req.on('response', h => { status = h[':status']; });
    req.on('data', d => { out += d; });
    const done = new Promise(r => req.on('end', r));
    req.write(HEAD);
    await new Promise(r => setTimeout(r, 100));
    req.end(EPILOGUE);
    await withTimeout(done, 5000, `h2c request ${i}`);
    assert.equal(status, 200);
    assert.deepEqual(JSON.parse(out), { uid: UID, size: 8 });
    assert.equal(await waitForRelease(limiter), 0, 'concurrency slot released');
  }
});

test('a uid after the file part in a later read still arrives when an epilogue follows (#244)', async (t) => {
  const { port, limiter } = await startApp(t);
  const fileThenUid = [
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.dmp"\r\n\r\n`),
    Buffer.alloc(200000, 0x4d),
    Buffer.from(`\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="uid"\r\n\r\n`)
  ];
  const uidTail = Buffer.from(`${UID}\r\n--${BOUNDARY}--\r\n`);
  const total = fileThenUid.reduce((n, b) => n + b.length, 0) + uidTail.length + EPILOGUE.length;
  const raw = await withTimeout(new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', async () => {
      socket.setNoDelay(true);
      socket.write(`POST /up HTTP/1.1\r\nHost: x\r\nContent-Type: multipart/form-data; boundary=${BOUNDARY}\r\nContent-Length: ${total}\r\nConnection: close\r\n\r\n`);
      socket.write(Buffer.concat(fileThenUid));
      await new Promise(r => setTimeout(r, 50));
      socket.write(uidTail);
      await new Promise(r => setTimeout(r, 100));
      socket.write(EPILOGUE);
    });
    let out = '';
    socket.on('data', d => { out += d; });
    socket.on('end', () => resolve(out));
    socket.on('error', reject);
  }), 5000, 'file-then-uid request');
  assert.deepEqual(JSON.parse(raw.split('\r\n\r\n').pop()), { uid: UID, size: 200000 });
  assert.equal(await waitForRelease(limiter), 0);
});
