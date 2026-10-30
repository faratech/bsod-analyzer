import test from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import net from 'node:net';
import fastifyMultipart from '@fastify/multipart';
import { createFastifyCompatApp } from '../server/fastifyCompat.js';
import { createUploadHandler } from '../server/uploadHandler.js';

const BOUNDARY = '----WebKitFormBoundaryAbCdEfGhIjKlMnOp';
const UID = 'a'.repeat(64);

// Browser-shaped body with the uid part AFTER the file part (the order the
// client used before #244).
function fileThenUidBody(fileLen) {
  const head = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.dmp"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const tail = `\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="uid"\r\n\r\n${UID}\r\n--${BOUNDARY}--\r\n`;
  return Buffer.concat([Buffer.from(head), Buffer.alloc(fileLen, 0x4d), Buffer.from(tail)]);
}

async function startApp(t, { http2: useH2 = false } = {}) {
  const app = createFastifyCompatApp(useH2 ? { http2: true } : {});
  app.fastify.register(fastifyMultipart, { limits: { fileSize: 1e8, files: 1, fields: 20, parts: 25 } });
  const upload = createUploadHandler({
    limits: { fileSize: 1e8, files: 1 },
    fileFilter: (_req, _file, cb) => cb(null, true)
  });
  app.post('/up', upload.single('file'), (req, res) => {
    res.json({ uid: req.body?.uid ?? null, size: req.file?.size ?? null });
  });
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  t.after(() => app.fastify.close());
  return app.fastify.server.address().port;
}

test('upload.single keeps a trailing field delivered in a later read than the end of the file (HTTP/1.1)', async (t) => {
  const port = await startApp(t);
  const buf = fileThenUidBody(200000);
  for (const lastLen of [5, 60, 100, 150]) {
    const raw = await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', async () => {
        socket.setNoDelay(true);
        socket.write(`POST /up HTTP/1.1\r\nHost: x\r\nContent-Type: multipart/form-data; boundary=${BOUNDARY}\r\nContent-Length: ${buf.length}\r\nConnection: close\r\n\r\n`);
        socket.write(buf.subarray(0, buf.length - lastLen));
        await new Promise(r => setTimeout(r, 30));
        socket.end(buf.subarray(buf.length - lastLen));
      });
      let out = '';
      socket.on('data', d => { out += d; });
      socket.on('end', () => resolve(out));
      socket.on('error', reject);
    });
    const json = JSON.parse(raw.split('\r\n\r\n').pop());
    assert.deepEqual(json, { uid: UID, size: 200000 }, `last ${lastLen} bytes delayed`);
  }
});

test('upload.single keeps a trailing field delivered in a later read than the end of the file (h2c)', async (t) => {
  const port = await startApp(t, { http2: true });
  const client = http2.connect(`http://127.0.0.1:${port}`);
  t.after(() => client.close());
  const buf = fileThenUidBody(200000);
  for (const lastLen of [5, 100]) {
    const req = client.request({
      ':method': 'POST',
      ':path': '/up',
      'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      'content-length': buf.length
    });
    let out = '';
    req.on('data', d => { out += d; });
    const done = new Promise(r => req.on('end', r));
    req.write(buf.subarray(0, buf.length - lastLen));
    await new Promise(r => setTimeout(r, 30));
    req.end(buf.subarray(buf.length - lastLen));
    await done;
    assert.deepEqual(JSON.parse(out), { uid: UID, size: 200000 }, `h2c last ${lastLen} bytes delayed`);
  }
});
