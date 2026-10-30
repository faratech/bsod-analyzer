import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import zlib from 'node:zlib';
import { rolldown } from 'rolldown';

// Bundles the real utils/zipSecurity.ts (JSZip included) for the browser and
// runs it against hand-built archives.
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));

async function loadZipSecurity() {
  const bundle = await rolldown({
    input: path.join(root, 'utils', 'zipSecurity.ts'),
    platform: 'browser',
    logLevel: 'silent',
  });
  const { output } = await bundle.generate({ format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(output[0].code, 'utf8').toString('base64')}`);
}

const zip = await loadZipSecurity();

// Builds a ZIP of deflated entries. `claimedSize` overrides the uncompressed
// size written to both the local header and the central directory.
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, claimedSize = data.length } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(claimedSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(claimedSize, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + compressed.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new File([Buffer.concat([...locals, cd, eocd])], 'dumps.zip', { type: 'application/zip' });
}

function dumpBytes(size, fill = 0x41) {
  const data = Buffer.alloc(size, fill);
  data.write('MDMP', 0, 'latin1');
  return data;
}

test('honest ZIPs extract every dump entry with its bytes intact', async () => {
  const a = dumpBytes(5000, 0x41);
  const b = dumpBytes(7000, 0x42);
  const { files, errors } = await zip.extractZipSafely(buildZip([
    { name: 'a.dmp', data: a },
    { name: 'sub/b.dmp', data: b },
  ]));
  assert.deepEqual(errors, []);
  assert.deepEqual(files.map(f => f.name), ['a.dmp', 'b.dmp']);
  assert.deepEqual(Buffer.from(await files[0].arrayBuffer()), a);
  assert.deepEqual(Buffer.from(await files[1].arrayBuffer()), b);
  assert.equal(files[1].sourcePath, 'sub/b.dmp');
});

test('an entry inflating past its declared size is aborted by the streaming counter (issue #233)', async () => {
  // 32 MB of zeros deflates to ~32 KB; the headers claim 1000 bytes, so the
  // metadata checks (size budget, compression ratio) pass.
  const lying = buildZip([{ name: 'crash.dmp', data: Buffer.alloc(32 * 1024 * 1024), claimedSize: 1000 }]);
  const validation = await zip.validateZipFile(lying);
  assert.equal(validation.valid, true, 'the central directory alone cannot reveal the lie');

  const { files, errors } = await zip.extractZipSafely(lying);
  assert.deepEqual(files, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /crash\.dmp/);
  assert.match(errors[0], /exceeds its declared size/,
    'aborted by the running byte counter, not by JSZip\'s post-inflate size check');
});

test('readZipEntryBounded stops at the byte limit it is given (issue #233)', async () => {
  const JSZip = (await import('jszip')).default;
  const archive = await JSZip.loadAsync(await buildZip([{ name: 'a.dmp', data: dumpBytes(256 * 1024) }]).arrayBuffer());
  const entry = archive.file('a.dmp');
  await assert.rejects(zip.readZipEntryBounded(entry, 64 * 1024), /exceeds/);
  const blob = await zip.readZipEntryBounded(entry, 256 * 1024);
  assert.equal(blob.size, 256 * 1024);
});

test('one failed entry does not discard the other dumps in the archive (issue #279)', async () => {
  const a = dumpBytes(5000, 0x41);
  const b = dumpBytes(7000, 0x42);
  const c = dumpBytes(6000, 0x43);
  // b.dmp's headers claim more bytes than it inflates to: JSZip rejects it.
  const { files, errors } = await zip.extractZipSafely(buildZip([
    { name: 'a.dmp', data: a },
    { name: 'b.dmp', data: b, claimedSize: 8000 },
    { name: 'c.dmp', data: c },
  ]));
  assert.deepEqual(files.map(f => f.name), ['a.dmp', 'c.dmp']);
  assert.deepEqual(Buffer.from(await files[0].arrayBuffer()), a);
  assert.deepEqual(Buffer.from(await files[1].arrayBuffer()), c);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^Failed to extract b\.dmp: /);
});

test('an entry lying about its size still stops at its declared size and only drops itself (issues #233, #279)', async () => {
  const a = dumpBytes(5000, 0x41);
  const c = dumpBytes(6000, 0x43);
  const { files, errors } = await zip.extractZipSafely(buildZip([
    { name: 'a.dmp', data: a },
    { name: 'bomb.dmp', data: Buffer.alloc(32 * 1024 * 1024), claimedSize: 1000 },
    { name: 'c.dmp', data: c },
  ]));
  assert.deepEqual(files.map(f => f.name), ['a.dmp', 'c.dmp']);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /bomb\.dmp/);
  assert.match(errors[0], /exceeds its declared size/);
});
