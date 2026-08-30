import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import JSZip from 'jszip';

import { createArchiveDumpExtractor } from '../server/archiveExtract.js';

const LIMITS = {
  maxRawFileSize: 100 * 1024 * 1024,
  maxExtractedSize: 100 * 1024 * 1024,
  maxFileCount: 20,
  maxCompressionRatio: 100
};

function makeExtractor(overrides = {}) {
  return createArchiveDumpExtractor({ ...LIMITS, ...overrides });
}

function makeDump(size = 64 * 1024) {
  // Random content: real dumps do not compress 100:1, so the ratio guard
  // stays out of the way unless a test specifically targets it.
  const buffer = randomBytes(size);
  buffer.write('MDMP', 0, 'ascii');
  return buffer;
}

async function makeZip(entries, { compression = 'DEFLATE' } = {}) {
  const zip = new JSZip();
  for (const [name, data] of entries) {
    zip.file(name, data);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression });
}

let has7z;
function sevenZipAvailable() {
  if (has7z === undefined) {
    try {
      execFileSync('which', ['7z'], { stdio: 'ignore' });
      has7z = true;
    } catch {
      has7z = false;
    }
  }
  return has7z;
}

test('zip archives extract through the bounded on-disk path (issue #76)', { skip: !sevenZipAvailable() }, async () => {
  const extractor = makeExtractor();
  const zip = await makeZip([
    ['nested/dir/one.dmp', makeDump()],
    ['two.dmp', makeDump()]
  ]);

  const dumps = await extractor.extractDumps(zip, 'upload.zip', 'zip');
  assert.equal(dumps.length, 2);
  const names = dumps.map(d => d.fileName).sort();
  assert.deepEqual(names, ['one.dmp', 'two.dmp']);
  for (const dump of dumps) {
    assert.ok(dump.buffer.slice(0, 4).toString('ascii') === 'MDMP');
    assert.ok(!dump.sourcePath.startsWith('/'));
  }
});

test('entries beyond the file-count cap are rejected from the listing', { skip: !sevenZipAvailable() }, async () => {
  const extractor = makeExtractor({ maxFileCount: 5 });
  const entries = [];
  for (let i = 0; i < 6; i++) entries.push([`d${i}.dmp`, makeDump()]);
  const zip = await makeZip(entries);

  await assert.rejects(
    () => extractor.extractDumps(zip, 'upload.zip', 'zip'),
    /too many files/i
  );
});

test('path traversal entries are rejected before extraction', { skip: !sevenZipAvailable() }, async () => {
  const extractor = makeExtractor();
  const zip = await makeZip([['a/../../evil.dmp', makeDump()]]);

  await assert.rejects(
    () => extractor.extractDumps(zip, 'upload.zip', 'zip'),
    /unsafe path/i
  );
});

test('invalid dumps are skipped while valid ones survive', { skip: !sevenZipAvailable() }, async () => {
  const extractor = makeExtractor();
  const garbage = randomBytes(64 * 1024); // right size, wrong magic
  const zip = await makeZip([
    ['garbage.dmp', garbage],
    ['good.dmp', makeDump()]
  ]);

  const dumps = await extractor.extractDumps(zip, 'upload.zip', 'zip');
  assert.equal(dumps.length, 1);
  assert.equal(dumps[0].fileName, 'good.dmp');
});

test('a dump larger than the per-file cap is rejected after extraction', { skip: !sevenZipAvailable() }, async () => {
  const extractor = makeExtractor({ maxRawFileSize: 32 * 1024 });
  const zip = await makeZip([['big.dmp', makeDump(64 * 1024)]]);

  await assert.rejects(
    () => extractor.extractDumps(zip, 'upload.zip', 'zip'),
    /too large/i
  );
});

test('compression bombs are rejected from the listing before any expansion', { skip: !sevenZipAvailable() }, async () => {
  const extractor = makeExtractor({ maxCompressionRatio: 10 });
  // ~5MB of zeros compresses to a few KB: ratio far above 10.
  const zip = await makeZip([['zeros.dmp', Buffer.alloc(5 * 1024 * 1024, 0)]]);

  await assert.rejects(
    () => extractor.extractDumps(zip, 'upload.zip', 'zip'),
    /archive bomb/i
  );
});

test('rar listings with symlink entries are rejected via bsdtar output', async () => {
  // bsdtar is not installed in this environment; stub the process runner with
  // realistic `bsdtar -tvf` output to pin the symlink guard.
  const listing = [
    'lrwxrwxrwx  1 root root      12 Jan  1 00:00 link.dmp -> /etc/passwd',
    '-rwxrwxrwa  1 root root   65536 Jan  1 00:00 ok.dmp'
  ].join('\n');
  const paths = 'link.dmp\nok.dmp';
  const run = async (bin, args) => {
    if (args[0] === 'tvf') return { stdout: listing };
    if (args[0] === 'tf') return { stdout: paths };
    return { stdout: '' };
  };
  const extractor = makeExtractor({ run });

  await assert.rejects(
    () => extractor.extractDumps(Buffer.alloc(1024), 'upload.rar', 'rar'),
    /symbolic links/i
  );
});

test('rar listings without parseable sizes are rejected rather than trusted', async () => {
  const listing = 'drwxrwxrwx  1 root root     ??? Jan  1 00:00 weird.dmp';
  const run = async (bin, args) => (args[0] === 'tvf' ? { stdout: listing } : { stdout: 'weird.dmp' });
  const extractor = makeExtractor({ run });

  await assert.rejects(
    () => extractor.extractDumps(Buffer.alloc(1024), 'upload.rar', 'rar'),
    /unable to determine uncompressed size/i
  );
});
