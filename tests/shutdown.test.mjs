import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';

import { createShutdownCoordinator } from '../server/shutdown.js';
import { createFastifyCompatApp } from '../server/fastifyCompat.js';

const silentLog = { info() {}, warn() {}, error() {} };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function recorder() {
  const exits = [];
  let resolveExit;
  const exited = new Promise(resolve => { resolveExit = resolve; });
  return {
    exits,
    exited,
    exit(code) {
      exits.push(code);
      resolveExit(code);
    }
  };
}

test('shutdown closes, runs drains, then exits 0 once', async () => {
  const order = [];
  const { exits, exit } = recorder();
  const coordinator = createShutdownCoordinator({
    close: async () => { order.push('close'); },
    drains: [async () => { order.push('drain'); }],
    exit,
    log: silentLog,
    graceMs: 200,
    forceMs: 400
  });
  assert.equal(coordinator.isDraining(), false);
  const run = coordinator.shutdown('SIGTERM');
  assert.equal(coordinator.isDraining(), true);
  await run;
  assert.deepEqual(order, ['close', 'drain']);
  assert.deepEqual(exits, [0]);
  // A second signal reuses the first run: nothing is closed or exited twice.
  await coordinator.shutdown('SIGINT');
  assert.deepEqual(order, ['close', 'drain']);
  assert.deepEqual(exits, [0]);
});

test('a close that outlives the grace exits non-zero at the grace, not later', async () => {
  const { exits, exit } = recorder();
  let drained = false;
  const coordinator = createShutdownCoordinator({
    close: () => new Promise(() => {}),
    drains: [async () => { drained = true; }],
    exit,
    log: silentLog,
    graceMs: 50,
    forceMs: 1000
  });
  const started = Date.now();
  await coordinator.shutdown('SIGTERM');
  assert.ok(Date.now() - started < 500);
  assert.deepEqual(exits, [1]);
  assert.equal(drained, false, 'no budget left for drains after the grace');
});

test('a hung drain is cut at the grace and a failing one does not block exit', async () => {
  const { exits, exit } = recorder();
  const coordinator = createShutdownCoordinator({
    close: async () => {},
    drains: [() => new Promise(() => {}), async () => { throw new Error('boom'); }],
    exit,
    log: silentLog,
    graceMs: 60,
    forceMs: 1000
  });
  await coordinator.shutdown('SIGTERM');
  assert.deepEqual(exits, [1]);
});

test('the hard deadline exits once even while close never settles', async () => {
  const { exits, exit, exited } = recorder();
  const coordinator = createShutdownCoordinator({
    close: () => new Promise(() => {}),
    exit,
    log: silentLog,
    graceMs: 120,
    forceMs: 30
  });
  coordinator.shutdown('SIGTERM');
  assert.equal(await exited, 1);
  await sleep(200);
  assert.deepEqual(exits, [1], 'the grace path does not exit a second time');
});

test('install registers SIGTERM and SIGINT once and each runs the same shutdown', async () => {
  const proc = new EventEmitter();
  const { exits, exit, exited } = recorder();
  let closes = 0;
  const coordinator = createShutdownCoordinator({
    close: async () => { closes += 1; },
    exit,
    log: silentLog,
    graceMs: 100,
    forceMs: 200
  });
  coordinator.install(proc);
  coordinator.install(proc);
  assert.equal(proc.listenerCount('SIGTERM'), 1);
  assert.equal(proc.listenerCount('SIGINT'), 1);
  proc.emit('SIGTERM');
  proc.emit('SIGINT');
  await exited;
  await sleep(10);
  assert.equal(closes, 1);
  assert.deepEqual(exits, [0]);
});

function rawRequest(port, path) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.on('connect', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n`);
    });
    socket.on('data', chunk => { data += chunk; });
    socket.on('error', reject);
    socket.on('close', () => resolve(data));
  });
}

test('real server: an in-flight request completes after the signal, new connections are refused', async () => {
  const app = createFastifyCompatApp({ compression: { enabled: false } });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const handlerEntered = new Promise(resolve => { entered = resolve; });
  app.get('/slow', async (req, res) => {
    entered();
    await gate;
    res.json({ ok: true });
  });
  await new Promise(resolve => app.listen(0, resolve));
  const port = app.fastify.server.address().port;

  const { exits, exit, exited } = recorder();
  const coordinator = createShutdownCoordinator({
    close: () => app.close(),
    server: app.fastify.server,
    exit,
    log: silentLog,
    graceMs: 3000,
    forceMs: 4000
  });

  // A keep-alive client: the socket only closes when the server closes it.
  const inFlight = rawRequest(port, '/slow');
  await handlerEntered;
  coordinator.shutdown('SIGTERM');
  await sleep(50);

  await assert.rejects(
    new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.on('connect', () => { socket.destroy(); resolve(); });
      socket.on('error', reject);
    }),
    { code: 'ECONNREFUSED' }
  );
  assert.deepEqual(exits, [], 'still draining while the request runs');

  release();
  const response = await inFlight;
  assert.match(response, /^HTTP\/1\.1 200/);
  assert.match(response, /"ok":true/);
  assert.equal(await exited, 0);
  coordinator.shutdown('SIGTERM');
  await sleep(10);
  assert.deepEqual(exits, [0]);
});

test('real h2c server: an open session gets GOAWAY after its in-flight stream and exit is clean', async () => {
  const http2 = await import('node:http2');
  const app = createFastifyCompatApp({ compression: { enabled: false }, http2: true });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const handlerEntered = new Promise(resolve => { entered = resolve; });
  app.get('/slow', async (req, res) => {
    entered();
    await gate;
    res.json({ ok: true });
  });
  // Created before listen, like server.js, so sessions are tracked from the start.
  const { exits, exit, exited } = recorder();
  const coordinator = createShutdownCoordinator({
    close: () => app.close(),
    server: app.fastify.server,
    exit,
    log: silentLog,
    graceMs: 3000,
    forceMs: 4000
  });
  await new Promise(resolve => app.listen(0, resolve));
  const port = app.fastify.server.address().port;

  const client = http2.connect(`http://127.0.0.1:${port}`);
  const goaway = new Promise(resolve => client.once('goaway', resolve));
  const body = new Promise((resolve, reject) => {
    const stream = client.request({ ':path': '/slow' });
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => { data += chunk; });
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
  await handlerEntered;
  const started = Date.now();
  coordinator.shutdown('SIGTERM');
  await goaway;
  release();
  assert.match(await body, /"ok":true/);
  assert.equal(await exited, 0);
  assert.ok(Date.now() - started < 2000, 'the idle session does not hold the close until the grace');
  client.close();
});
