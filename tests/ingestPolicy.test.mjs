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

test('shared policy rejects unsafe paths and keeps safe nested dump paths', () => {
  assert.equal(validatePathEntry('folder/crash.mdmp'), true);
  assert.equal(validatePathEntry('a/b/c/dump.kdmp'), true);
  assert.equal(validatePathEntry('../crash.dmp'), false);
  assert.equal(validatePathEntry('/absolute/crash.dmp'), false);
  assert.equal(validatePathEntry('a/b/c/d/e/crash.dmp'), false);
  assert.equal(validatePathEntry('a/./crash.dmp'), false);
});

test('shared policy detects archive magic and rejects extension mismatch', () => {
  const zip = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0, 0, 0, 0]);
  const sevenZip = Buffer.from([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C, 0, 0]);
  const rar = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x01, 0x00]);

  assert.equal(detectArchiveType(zip), 'zip');
  assert.equal(detectArchiveType(sevenZip), '7z');
  assert.equal(detectArchiveType(rar), 'rar');
  assert.equal(validateUploadedBuffer(zip, 'archive.7z').valid, false);
});

test('filename helpers normalize dangerous upload names', () => {
  assert.equal(getFileExtension('C:\\temp\\crash.MDMP'), '.mdmp');
  assert.equal(sanitizeUploadFileName('../bad\r\nname.mdmp'), 'bad_name.mdmp');
  assert.equal(sanitizeUploadFileName(''), 'upload.dmp');
});
