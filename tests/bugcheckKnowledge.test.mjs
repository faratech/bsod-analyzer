import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { transform } from 'rolldown/experimental';
import { describeBugcheck, BUGCHECK_MEANINGS } from '../server/bugcheckKnowledge.js';

async function loadBugCheckCodes() {
  const url = new URL('../utils/bugCheckCodes.ts', import.meta.url);
  const source = await fs.readFile(url, 'utf8');
  const { code } = await transform('bugCheckCodes.ts', source);
  return import(`data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`);
}

test('every BUGCHECK_MEANINGS key is a known bug check code (issue #371)', async () => {
  const { BUG_CHECK_CODES } = await loadBugCheckCodes();
  for (const key of Object.keys(BUGCHECK_MEANINGS)) {
    assert.match(key, /^0x[0-9A-F]+$/, `${key} is canonical short hex`);
    assert.ok(BUG_CHECK_CODES[Number(key)], `${key} is in BUG_CHECK_CODES`);
  }
});

// Keyword sanity checks: each description must be about the code its key
// names (Microsoft Learn bug check / live dump reference), not a neighbour.
const MUST = {
  '0x7F': [/trap/i],
  '0xC5': [/pool/i],
  '0xC9': [/Driver Verifier/i, /I\/O/],
  '0x116': [/reset/i, /fail/i],
  '0x117': [/live dump/i, /recover/i],
  '0x139': [/critical data structure/i],
  '0x15F': [/live dump/i, /connected standby/i],
  '0x18B': [/secure kernel/i, /fatal/i],
  '0x192': [/AutoBoost/i, /DISPATCH_LEVEL/],
  '0x19C': [/Win32k/i, /monitor/i],
  '0x1A0': [/terminal topology manager/i],
  '0x1A6': [/Bluetooth/i, /live dump/i],
  '0x1C8': [/power button/i, /not what went wrong first/i],
  '0xE2': [/keyboard/i, /debugger/i],
};
const MUST_NOT = {
  '0x7F': [/^Double fault/i],
  '0x116': [/recovered twice/i],
  '0x117': [/failed to reset/i],
  '0x192': [/power transition/i],
  '0x19C': [/secure world/i],
  '0x1A0': [/TPM/],
  '0x1A6': [/video|TDR|GPU/i],
  '0x15F': [/exited unexpectedly/i],
};

test('fixed descriptions match their bug check names (issue #371)', async () => {
  const { BUG_CHECK_CODES } = await loadBugCheckCodes();
  for (const [code, patterns] of Object.entries(MUST)) {
    const description = describeBugcheck(code, BUG_CHECK_CODES[Number(code)]);
    for (const pattern of patterns) assert.match(description, pattern, `${code}: ${description}`);
  }
  for (const [code, patterns] of Object.entries(MUST_NOT)) {
    const description = describeBugcheck(code, BUG_CHECK_CODES[Number(code)]);
    for (const pattern of patterns) assert.doesNotMatch(description, pattern, `${code}: ${description}`);
  }
});

test('file-system fallback matches Microsoft FILE_SYSTEM names, not network/IPC ones (issue #371)', () => {
  const storage = describeBugcheck('0x999990', 'DISK_HARDWARE_ERROR_X');
  assert.match(storage, /storage/i);
  for (const name of ['NTFS_FILE_SYSTEM', 'FAT_FILE_SYSTEM', 'EXFAT_FILE_SYSTEM', 'REFS_FILE_SYSTEM', 'FILE_SYSTEM']) {
    assert.equal(describeBugcheck('0x999990', name), storage, name);
  }
  for (const name of ['RDR_FILE_SYSTEM', 'DFS_FILE_SYSTEM', 'MUP_FILE_SYSTEM', 'NPFS_FILE_SYSTEM', 'MAILSLOT_FILE_SYSTEM']) {
    const description = describeBugcheck('0x999990', name);
    assert.notEqual(description, storage, name);
    assert.match(description, /network|named pipe|mailslot/i, name);
  }
  assert.notEqual(describeBugcheck('0x999990', 'RAMDISK_BOOT_INITIALIZATION_FAILED'), storage);
});
