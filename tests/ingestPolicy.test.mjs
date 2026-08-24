import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_EXTENSIONS,
  FILE_LIMITS,
  detectArchiveType,
  getFileExtension,
  isArchiveFileName,
  isDumpFileName,
  sanitizeUploadFileName,
  validatePathEntry,
  validateUploadedBuffer
} from '../shared/ingestPolicy.js';

const dumpHeader = Buffer.concat([
  Buffer.from('MDMP', 'ascii'),
  Buffer.alloc(FILE_LIMITS.minDumpSize)
]);

test('shared policy accepts all advertised upload extensions', () => {
  assert.deepEqual(ALLOWED_EXTENSIONS, ['.dmp', '.mdmp', '.hdmp', '.kdmp', '.zip', '.7z', '.rar']);
  for (const ext of ['.dmp', '.mdmp', '.hdmp', '.kdmp']) {
    assert.equal(isDumpFileName(`crash${ext}`), true);
    assert.equal(validateUploadedBuffer(dumpHeader, `crash${ext}`, { allowArchives: false }).valid, true);
  }
  for (const ext of ['.zip', '.7z', '.rar']) {
    assert.equal(isArchiveFileName(`archive${ext}`), true);
  }
});

test('shared policy rejects undersized dumps and archives', () => {
  const tinyDump = Buffer.from('MDMP', 'ascii');
  const tinyZip = Buffer.from([0x50, 0x4B, 0x03, 0x04]);
  const paddedZip = Buffer.concat([
    Buffer.from([0x50, 0x4B, 0x03, 0x04]),
    Buffer.alloc(FILE_LIMITS.minArchiveSize)
  ]);

  assert.equal(validateUploadedBuffer(tinyDump, 'tiny.dmp', { allowArchives: false }).valid, false);
  assert.equal(validateUploadedBuffer(tinyZip, 'tiny.zip').valid, false);
  assert.equal(validateUploadedBuffer(paddedZip, 'archive.zip').valid, true);
});

test('shared policy rejects unsafe paths and keeps safe nested dump paths', () => {
  assert.equal(validatePathEntry('folder/crash.mdmp'), true);
  assert.equal(validatePathEntry('a/b/c/dump.kdmp'), true);
  assert.equal(validatePathEntry('../crash.dmp'), false);
  assert.equal(validatePathEntry('/absolute/crash.dmp'), false);
  assert.equal(validatePathEntry('a/b/c/d/e/crash.dmp'), false);
  assert.equal(validatePathEntry('a/./crash.dmp'), false);
});

test('shared policy detects archive magic and accepts supported extension mismatch', () => {
  const zip = Buffer.alloc(FILE_LIMITS.minArchiveSize);
  Buffer.from([0x50, 0x4B, 0x03, 0x04]).copy(zip);
  const sevenZip = Buffer.from([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C, 0, 0]);
  const rar = Buffer.alloc(FILE_LIMITS.minArchiveSize);
  Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x01, 0x00]).copy(rar);

  assert.equal(detectArchiveType(zip), 'zip');
  assert.equal(detectArchiveType(sevenZip), '7z');
  assert.equal(detectArchiveType(rar), 'rar');
  const result = validateUploadedBuffer(zip, 'archive.7z');
  assert.equal(result.valid, true);
  assert.equal(result.archiveType, 'zip');
  const mislabeledRar = validateUploadedBuffer(rar, 'Mini Dump.zip');
  assert.equal(mislabeledRar.valid, true);
  assert.equal(mislabeledRar.archiveType, 'rar');
});

test('filename helpers normalize dangerous upload names', () => {
  assert.equal(getFileExtension('C:\\temp\\crash.MDMP'), '.mdmp');
  assert.equal(sanitizeUploadFileName('../bad\r\nname.mdmp'), 'bad_name.mdmp');
  assert.equal(sanitizeUploadFileName(''), 'upload.dmp');
});
