import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';

import { createArchiveDumpExtractor, selectAnalyzableDump } from '../server/archiveExtract.js';

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

test('a missing extractor binary keeps its spawn code so callers report a 5xx', async () => {
  const run = async () => {
    throw Object.assign(new Error('spawn 7z ENOENT'), { code: 'ENOENT' });
  };
  const extractor = makeExtractor({ run });

  await assert.rejects(
    () => extractor.extractDumps(Buffer.alloc(1024), 'upload.7z', '7z'),
    error => error.code === 'ENOENT' && /Failed to read archive/.test(error.message)
  );
});

test('a bad archive (non-zero tool exit) carries no infrastructure code', async () => {
  const run = async () => {
    throw Object.assign(new Error('Command failed: 7z l'), { code: 2, stderr: 'Can not open the file as archive' });
  };
  const extractor = makeExtractor({ run });

  await assert.rejects(
    () => extractor.extractDumps(Buffer.alloc(1024), 'upload.7z', '7z'),
    error => error.code === undefined && /Failed to read archive/.test(error.message)
  );
});

// Issue #275: extraction keeps 32-bit PAGEDUMP files for the browser, and
// /api/analyze took extractedDumps[0] and rejected the whole archive when that
// one was 32-bit even if a later dump was analyzable.
function make32BitPageDump(size = 64 * 1024) {
  const buffer = randomBytes(size);
  buffer.write('PAGEDUMP', 0, 'ascii');
  return buffer;
}

test('selectAnalyzableDump picks the first dump that passes strict validation (#275)', () => {
  const dumps = [
    { fileName: 'a_old32.dmp', buffer: make32BitPageDump() },
    { fileName: 'b_mini.dmp', buffer: makeDump() }
  ];
  const selection = selectAnalyzableDump(dumps);
  assert.equal(selection.dump?.fileName, 'b_mini.dmp');
  assert.equal(selection.skipped.length, 1);
  assert.equal(selection.skipped[0].fileName, 'a_old32.dmp');
  assert.equal(selection.skipped[0].code, 'UNSUPPORTED_DUMP_TYPE');
});

test('selectAnalyzableDump returns the first dump\'s rejection when none passes (#275)', () => {
  const selection = selectAnalyzableDump([
    { fileName: 'one32.dmp', buffer: make32BitPageDump() },
    { fileName: 'two32.dmp', buffer: make32BitPageDump() }
  ]);
  assert.equal(selection.dump, null);
  assert.equal(selection.validation.valid, false);
  assert.equal(selection.validation.code, 'UNSUPPORTED_DUMP_TYPE');
  assert.equal(selection.skipped.length, 2);
});

for (const archiveType of ['zip', '7z']) {
  test(`a ${archiveType} with a 32-bit dump before a minidump selects the minidump (#275)`, { skip: !sevenZipAvailable() }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsod-mixed-'));
    try {
      fs.writeFileSync(path.join(dir, 'a_old32.dmp'), make32BitPageDump());
      fs.writeFileSync(path.join(dir, 'b_mini.dmp'), makeDump());
      const archivePath = path.join(dir, `mixed.${archiveType}`);
      execFileSync('7z', ['a', `-t${archiveType}`, archivePath, 'a_old32.dmp', 'b_mini.dmp'], { cwd: dir, stdio: 'ignore' });
      const dumps = await makeExtractor().extractDumps(fs.readFileSync(archivePath), `mixed.${archiveType}`, archiveType);
      assert.equal(dumps.length, 2, 'extraction keeps the 32-bit dump for the browser path');
      const selection = selectAnalyzableDump(dumps);
      assert.equal(selection.dump?.fileName, 'b_mini.dmp');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
