import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapStructuredSignalToReport,
  mergeReportWithWinDbgFields,
  parseWinDbgOutput
} from '../shared/windbgReportFields.js';

test('structured WinDBG signal maps authoritative report fields deterministically', () => {
  const fields = mapStructuredSignalToReport({
    bugcheck: {
      code: '0xA',
      name: 'IRQL_NOT_LESS_OR_EQUAL',
      parameters: ['29c9a2', '2', '0', 'fffff8009fa62f2a']
    },
    crash: {
      failureBucketId: 'AV_nt!KiExecuteAllDpcs',
      symbolName: 'nt!KiExecuteAllDpcs+8ca',
      moduleName: 'nt',
      imageName: 'ntkrnlmp.exe',
      imageVersion: '10.0.26100.4061',
      readAddress: 'fffff800`00001234',
      processName: 'System'
    },
    target: {
      os_version: 'Windows 10 Kernel Version 26100',
      system_uptime: '0 days 2:02:06.259'
    },
    registers: { rip: 'fffff8009fd01c40', rsp: 'fffff8003231e488' },
    stackFrames: [{
      sp: 'fffff8003231e760',
      ret_addr: 'fffff8009fb6d956',
      symbol: ': nt!KiExecuteAllDpcs+0x8ca'
    }],
    notableModules: [{
      name: 'nt',
      base: 'fffff8009f800000',
      details: {
        imageName: 'ntkrnlmp.exe',
        fileVersion: '10.0.26100.8246',
        timestamp: '2026-08-20'
      }
    }]
  }, {
    explainBugCheckParameter: (_code, parameter, value) => `P${parameter}=${value.toString(16)}`
  });

  assert.deepEqual(fields.bugCheck, {
    code: '0xA',
    name: 'IRQL_NOT_LESS_OR_EQUAL',
    parameters: [
      { value: '29c9a2', meaning: 'P1=29c9a2' },
      { value: '2', meaning: 'P2=2' },
      { value: '0', meaning: 'P3=0' },
      { value: 'fffff8009fa62f2a', meaning: 'P4=fffff8009fa62f2a' }
    ]
  });
  assert.equal(fields.failureBucketId, 'AV_nt!KiExecuteAllDpcs');
  assert.equal(fields.symbolName, 'nt!KiExecuteAllDpcs+8ca');
  assert.equal(fields.moduleName, 'nt');
  assert.equal(fields.imageName, 'ntkrnlmp.exe');
  assert.equal(fields.imageBuild, '26100.4061');
  assert.equal(fields.faultAddress, 'fffff800`00001234');
  assert.equal(fields.systemInfo.windowsVersion, 'Windows 10 Kernel Version 26100');
  assert.equal(fields.systemInfo.processName, 'System');
  assert.equal(fields.systemInfo.kernelImageVersion, '10.0.26100.8246');
  assert.equal(fields.systemInfo.kernelBuild, '26100.8246');
  assert.deepEqual(fields.registers, { rip: 'fffff8009fd01c40', rsp: 'fffff8003231e488' });
  assert.deepEqual(fields.callStack[0], {
    address: 'fffff8003231e760',
    module: 'nt',
    function: 'KiExecuteAllDpcs',
    offset: '0x8ca'
  });
  assert.equal(fields.loadedModules[0].isCulprit, true);
});

test('raw WinDBG parser recovers browser report fields and isolates analyze output', () => {
  const output = [
    'debugger setup noise',
    '',
    '===== STEP_04_analyze_v =====',
    'IRQL_NOT_LESS_OR_EQUAL (a)',
    'OS_VERSION: 10.0.26100.4061',
    'SYSTEM_UPTIME: 0 days 2:02:06.259',
    'PROCESS_NAME: System',
    'READ_ADDRESS: fffff800`00001234',
    'MODULE_NAME: nt',
    'IMAGE_NAME: ntkrnlmp.exe',
    'IMAGE_VERSION: 10.0.26100.4061',
    'FAILURE_BUCKET_ID: AV_nt!KiExecuteAllDpcs',
    'STACK_TEXT:',
    'fffff800`3231e760 nt!KiExecuteAllDpcs+0x8ca',
    '',
    'SYMBOL_NAME: nt!KiExecuteAllDpcs+8ca',
    '',
    '===== STEP_09_lmv =====',
    'fffff800`9f800000 fffff800`a0800000 nt',
    '    Loaded symbol image file: ntkrnlmp.exe',
    '    Image name: ntkrnlmp.exe',
    '    File version: 10.0.26100.8246'
  ].join('\n');

  const fields = parseWinDbgOutput(output);
  assert.equal(fields.failureBucketId, 'AV_nt!KiExecuteAllDpcs');
  assert.equal(fields.symbolName, 'nt!KiExecuteAllDpcs+8ca');
  assert.equal(fields.moduleName, 'nt');
  assert.equal(fields.imageName, 'ntkrnlmp.exe');
  assert.equal(fields.imageVersion, '10.0.26100.4061');
  assert.equal(fields.imageBuild, '26100.4061');
  assert.equal(fields.faultAddress, 'fffff800`00001234');
  assert.equal(fields.systemInfo.windowsVersion, '10.0.26100.4061');
  assert.equal(fields.systemInfo.kernelImageVersion, '10.0.26100.8246');
  assert.equal(fields.systemInfo.kernelBuild, '26100.8246');
  assert.equal(fields.systemInfo.systemUptime, '0 days 2:02:06.259');
  assert.deepEqual(fields.callStack[0], {
    address: 'fffff800`3231e760',
    module: 'nt',
    function: 'KiExecuteAllDpcs',
    offset: '0x8ca'
  });
  assert.match(fields.rawWinDbgOutput, /^IRQL_NOT_LESS_OR_EQUAL/);
  assert.doesNotMatch(fields.rawWinDbgOutput, /debugger setup noise|STEP_09_lmv/);
});

test('deterministic fields override AI guesses without deleting unrelated system data', () => {
  const report = {
    summary: 'AI summary',
    probableCause: 'AI cause',
    culprit: 'guessed.sys',
    recommendations: ['Update guessed.sys'],
    failureBucketId: 'AI_BUCKET',
    systemInfo: { windowsVersion: 'AI version', processName: 'ai.exe' }
  };
  const structuredFields = {
    failureBucketId: 'STRUCTURED_BUCKET',
    systemInfo: { processName: 'System', systemUptime: '1 day' }
  };
  const parsedFields = {
    failureBucketId: 'RAW_BUCKET',
    moduleName: 'nt',
    systemInfo: { kernelBuild: '26100.8246' }
  };

  const merged = mergeReportWithWinDbgFields(report, structuredFields, parsedFields);
  assert.equal(merged.failureBucketId, 'RAW_BUCKET');
  assert.equal(merged.moduleName, 'nt');
  assert.deepEqual(merged.systemInfo, {
    windowsVersion: 'AI version',
    processName: 'System',
    systemUptime: '1 day',
    kernelBuild: '26100.8246'
  });

  const serverFields = mapStructuredSignalToReport({
    bugcheck: { code: '0xA', name: 'IRQL_NOT_LESS_OR_EQUAL', parameters: ['2'] },
    crash: {}
  });
  assert.equal(serverFields.bugCheck.parameters[0].meaning, 'Bug check parameter 1');
  assert.equal(Object.hasOwn(serverFields, 'failureBucketId'), false);
});
