// Archive → dump extraction via the bounded 7z/bsdtar path (issue #76).
//
// Every supported format — including .zip — goes through "list first, then
// extract to disk, then verify on disk": listed sizes, entry counts, and the
// compression ratio are checked against the archive metadata BEFORE any
// expansion, and the expanded files are re-verified with lstat() as they are
// read back. Expanded bytes therefore never enter the Node heap unbounded, and
// a lying central directory cannot buy a memory spike the way the old in-memory
// JSZip path allowed. Extracted from server.js with injectable limits and
// process runner so tests can exercise it directly.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

import {
  sanitizeUploadFileName,
  validatePathEntry,
  validateUploadedBuffer
} from '../shared/ingestPolicy.js';

const execFileAsync = promisify(execFile);

export function createArchiveDumpExtractor({
  maxRawFileSize,
  maxExtractedSize,
  maxFileCount,
  maxCompressionRatio,
  run = execFileAsync,
  fsImpl = fs
} = {}) {
  const DUMP_EXTENSIONS = ['.dmp', '.mdmp', '.hdmp', '.kdmp'];

  async function listVia7z(archivePath) {
    let listOutput;
    try {
      listOutput = await run('7z', ['l', '-slt', archivePath], { timeout: 15000 });
    } catch (err) {
      if (err?.stderr && err.stderr.includes('Wrong password')) {
        throw new Error('Password-protected archives are not supported');
      }
      throw new Error(`Failed to read archive: ${err?.message || err}`);
    }
    return listOutput.stdout;
  }

  async function extractVia7z(archivePath, extractDir) {
    try {
      await run('7z', ['x', `-o${extractDir}`, '-y', archivePath], { timeout: 30000 });
    } catch (err) {
      if (err?.stderr && err.stderr.includes('Wrong password')) {
        throw new Error('Password-protected archives are not supported');
      }
      throw new Error(`Failed to extract archive: ${err?.message || err}`);
    }
  }

  function checkListedBounds(totalListedSize, fileCount, compressedSize) {
    if (totalListedSize > maxExtractedSize) {
      throw new Error(`Archive too large when extracted (${(totalListedSize / 1024 / 1024).toFixed(1)}MB). Maximum is ${(maxExtractedSize / 1024 / 1024).toFixed(0)}MB.`);
    }
    if (fileCount > maxFileCount) {
      throw new Error(`Archive contains too many files (${fileCount}). Maximum is ${maxFileCount}.`);
    }
    if (compressedSize > 0 && totalListedSize / compressedSize > maxCompressionRatio) {
      throw new Error('Archive compression ratio too high — possible archive bomb');
    }
  }

  async function listAndExtractWith7z(buffer, archivePath, extractDir) {
    const listing = await listVia7z(archivePath);
    const sizeMatches = listing.matchAll(/^Size = (\d+)$/gm);
    const pathMatches = listing.matchAll(/^Path = (.+)$/gm);
    let totalExtractedSize = 0;
    let fileCount = 0;

    for (const match of pathMatches) {
      const entryPath = match[1];
      if (entryPath === archivePath || entryPath === path.basename(archivePath)) continue;
      if (!validatePathEntry(entryPath)) {
        throw new Error('Archive contains an unsafe path');
      }
    }

    for (const match of sizeMatches) {
      totalExtractedSize += parseInt(match[1], 10);
      fileCount++;
    }

    checkListedBounds(totalExtractedSize, fileCount, buffer.length);
    await extractVia7z(archivePath, extractDir);
  }

  async function listAndExtractWithBsdtar(buffer, archivePath, extractDir) {
    // bsdtar for RAR (Alpine's 7zip lacks the RAR codec). The verbose listing
    // exposes each entry's uncompressed size, allowing bomb rejection before
    // any expanded data is written to disk.
    let listOutput;
    try {
      listOutput = await run('bsdtar', ['tvf', archivePath], { timeout: 15000 });
    } catch (err) {
      if (err?.stderr && (err.stderr.includes('password') || err.stderr.includes('encrypted'))) {
        throw new Error('Password-protected archives are not supported');
      }
      throw new Error(`Failed to read RAR archive: ${err?.stderr || err?.message || err}`);
    }

    let pathOutput;
    try {
      pathOutput = await run('bsdtar', ['tf', archivePath], { timeout: 15000 });
    } catch (err) {
      throw new Error(`Failed to read RAR archive paths: ${err?.stderr || err?.message || err}`);
    }
    const listedPaths = pathOutput.stdout.trim().split('\n').filter(Boolean);
    for (const entryPath of listedPaths) {
      if (!validatePathEntry(entryPath)) {
        throw new Error('Archive contains an unsafe path');
      }
    }

    const fileList = listOutput.stdout.trim().split('\n').filter(f => f.length > 0);
    let totalListedSize = 0;
    for (const line of fileList) {
      if (/^\s*l/.test(line)) {
        throw new Error('Archive contains symbolic links, which are not supported');
      }
      const columns = line.trim().split(/\s+/);
      // Expected bsdtar -tvf shape: mode links owner group size date... name
      const size = Number.parseInt(columns[4], 10);
      if (!Number.isFinite(size) || size < 0) {
        throw new Error('Failed to read RAR archive: unable to determine uncompressed size');
      }
      totalListedSize += size;
    }

    checkListedBounds(totalListedSize, fileList.length, buffer.length);

    try {
      await run('bsdtar', ['xf', archivePath, '-C', extractDir], { timeout: 30000 });
    } catch (err) {
      if (err?.stderr && (err.stderr.includes('password') || err.stderr.includes('encrypted'))) {
        throw new Error('Password-protected archives are not supported');
      }
      throw new Error(`Failed to extract RAR archive: ${err?.stderr || err?.message || err}`);
    }
  }

  // Post-extraction walk: verify what actually landed on disk. lstat() avoids
  // following symlinks, and realpath() bounds every file to the extract dir.
  function collectDumpFiles(extractDir, results) {
    const realExtractDir = fsImpl.realpathSync(extractDir);
    let dumpCount = 0;
    let dumpBytes = 0;

    function walk(dir) {
      const entries = fsImpl.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        const lstat = fsImpl.lstatSync(fullPath);
        if (lstat.isSymbolicLink()) {
          console.warn('[Archive] Symlink entry rejected:', fullPath);
          continue;
        }

        const realPath = fsImpl.realpathSync(fullPath);
        if (realPath !== realExtractDir && !realPath.startsWith(realExtractDir + path.sep)) {
          console.warn('[Archive] Path traversal detected, skipping:', fullPath);
          continue;
        }
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (DUMP_EXTENSIONS.some(ext => entry.name.toLowerCase().endsWith(ext))) {
          if (dumpCount >= maxFileCount) {
            throw new Error(`Archive contains too many dump files. Maximum is ${maxFileCount}.`);
          }
          if (lstat.size > maxRawFileSize) {
            throw new Error(`Extracted dump is too large (${(lstat.size / 1024 / 1024).toFixed(1)}MB). Maximum is ${(maxRawFileSize / 1024 / 1024).toFixed(0)}MB.`);
          }
          if (dumpBytes + lstat.size > maxExtractedSize) {
            throw new Error(`Extracted dumps exceed ${(maxExtractedSize / 1024 / 1024).toFixed(0)}MB.`);
          }
          const content = fsImpl.readFileSync(fullPath);
          dumpCount++;
          dumpBytes += content.length;
          const sourcePath = path.relative(extractDir, fullPath).replace(/\\/g, '/');
          const fileName = sanitizeUploadFileName(entry.name);
          const validation = validateUploadedBuffer(content, fileName, { allowArchives: false });
          if (!validation.valid) {
            console.warn('[Archive] Invalid dump skipped:', validation.error);
            continue;
          }
          results.push({
            fileName,
            sourcePath,
            buffer: content
          });
        }
      }
    }

    walk(extractDir);
  }

  // archiveType: 'zip' and '7z' share the 7z tooling; 'rar' uses bsdtar.
  async function extractDumps(buffer, originalName, archiveType) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsod-extract-'));
    const archivePath = path.join(tmpDir, `archive.${archiveType}`);
    const extractDir = path.join(tmpDir, 'out');

    try {
      fs.writeFileSync(archivePath, buffer);
      fs.mkdirSync(extractDir);

      if (archiveType === 'rar') {
        await listAndExtractWithBsdtar(buffer, archivePath, extractDir);
      } else {
        await listAndExtractWith7z(buffer, archivePath, extractDir);
      }

      const results = [];
      collectDumpFiles(extractDir, results);
      return results;
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (cleanupErr) {
        console.error('[Archive] Cleanup error:', cleanupErr.message);
      }
    }
  }

  return { extractDumps };
}
