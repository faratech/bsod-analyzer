import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateForumReport,
  generateMarkdownReport,
  getReportFacts,
  redactPublicReportText
} from '../shared/reportFacts.js';

function dumpFile(report, overrides = {}) {
  return {
    id: 'dump-1',
    displayName: 'MEMORY.DMP',
    file: { name: 'MEMORY.DMP', size: 4096 },
    status: 'analyzed',
    analysisMethod: 'windbg',
    report,
    ...overrides
  };
}

test('report facts prefer precise kernel build evidence', () => {
  const facts = getReportFacts(dumpFile({
    summary: 'Crash in the Windows kernel scheduler.',
    probableCause: 'WinDbg identified nt!KiExecuteAllDpcs.',
    culprit: 'nt',
    recommendations: ['Install the latest cumulative update.'],
    imageName: 'ntkrnlmp.exe',
    imageVersion: '10.0.26200.8655',
    systemInfo: {
      windowsVersion: 'Windows 10 Kernel Version 26200 MP (16 procs) Free x64'
    }
  }));

  assert.equal(facts.kernelBuild, '26200.8655');
  assert.ok(facts.facts.some(fact => fact.label === 'Build' && fact.value === '26200.8655'));
  assert.ok(facts.facts.some(fact => fact.label === 'Image' && fact.value === 'ntkrnlmp.exe'));
});

test('report facts do not treat third-party image versions as Windows builds', () => {
  const facts = getReportFacts(dumpFile({
    summary: 'Crash in a display driver.',
    probableCause: 'WinDbg identified nvlddmkm.',
    culprit: 'nvlddmkm.sys',
    recommendations: ['Update the NVIDIA display driver.'],
    imageName: 'nvlddmkm.sys',
    imageVersion: '32.0.15.7628',
    systemInfo: {
      windowsVersion: 'Windows 10 Kernel Version 26100'
    }
  }));

  assert.equal(facts.kernelBuild, 'Windows 10 Kernel Version 26100');
  assert.ok(facts.facts.some(fact => fact.label === 'Image version' && fact.value === '32.0.15.7628'));
});

test('forum report is concise and privacy-safe', () => {
  const report = generateForumReport(dumpFile({
    summary: 'Dump came from C:\\Users\\Alice\\Desktop and source 203.0.113.42.',
    probableCause: 'Failure bucket WF-12345678-1234-1234-1234-123456789abc-42 points to nt.',
    culprit: 'nt',
    recommendations: ['Review C:\\Temp\\MEMORY.DMP before sharing.'],
    bugCheck: { code: '0xA', name: 'IRQL_NOT_LESS_OR_EQUAL', parameters: [] },
    failureBucketId: 'WF-12345678-1234-1234-1234-123456789abc-42',
    rawWinDbgOutput: 'PRIVATE_RAW_OUTPUT 203.0.113.42 C:\\Users\\Alice\\dump.dmp',
    systemInfo: {
      kernelImageVersion: '10.0.26200.8655'
    }
  }));

  assert.match(report, /Windows build:\*\* `26200\.8655`/);
  assert.doesNotMatch(report, /203\.0\.113\.42/);
  assert.doesNotMatch(report, /C:\\Users\\Alice/);
  assert.doesNotMatch(report, /WF-12345678-1234-1234-1234-123456789abc-42/);
  assert.doesNotMatch(report, /PRIVATE_RAW_OUTPUT/);
});

test('markdown export keeps technician evidence', () => {
  const report = generateMarkdownReport(dumpFile({
    summary: 'Crash in nt.',
    probableCause: 'WinDbg identified nt.',
    culprit: 'nt',
    recommendations: ['Review the stack.'],
    rawWinDbgOutput: 'RAW_WINDBG_OUTPUT',
    systemInfo: {
      kernelImageVersion: '10.0.26200.8655'
    }
  }));

  assert.match(report, /Build:\*\* `26200\.8655`/);
  assert.match(report, /Raw WinDbg Output/);
  assert.match(report, /RAW_WINDBG_OUTPUT/);
});

test('public redaction removes direct identifiers', () => {
  const text = redactPublicReportText('ip 198.51.100.20 path C:\\Crash\\MEMORY.DMP id 12345678-1234-1234-1234-123456789abc');

  assert.equal(text, 'ip [ip-redacted] path [path-redacted] id [id-redacted]');
});
