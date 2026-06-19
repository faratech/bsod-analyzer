import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractWinDbgWindowsVersion,
  formatWindowsVersion
} from '../shared/windowsVersion.js';

test('Windows version parser ignores non-OS module ProductVersion values', () => {
  const output = `
lm kv output
    ProductVersion: 103.4.3.103947305
    FileVersion: 103.4.3.103947305
`;

  assert.equal(extractWinDbgWindowsVersion(output), null);
  assert.equal(formatWindowsVersion('103.4.3.103947305'), null);
});

test('Windows version parser prefers OS_VERSION over module versions', () => {
  const output = `
    ProductVersion: 103.4.3.103947305
OS_VERSION: 10.0.26100.1
`;

  assert.equal(extractWinDbgWindowsVersion(output), 'Windows 11 24H2 (10.0.26100.1)');
});

test('Windows version parser reads WinDbg kernel banner build numbers', () => {
  const output = 'Windows 10 Kernel Version 22631 MP (16 procs) Free x64';

  assert.equal(extractWinDbgWindowsVersion(output), 'Windows 11 23H2 (10.0.22631)');
});
