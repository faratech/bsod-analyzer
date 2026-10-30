import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapStructuredSignalToReport,
  mergeReportWithWinDbgFields,
  parseStackText,
  parseWinDbgOutput
} from '../shared/windbgReportFields.js';

// Real `!analyze -v` STACK_TEXT / `kv` lines: Child-SP RetAddr : Args to Child : Call Site.
const KV_KEBUGCHECK = 'ffff8a0c`5c2f6f48 fffff803`63a2b5a9     : 00000000`0000000a 00000000`00000010 00000000`00000002 00000000`00000000 : nt!KeBugCheckEx';
const KV_DISPATCH = 'ffff8a0c`5c2f6f50 fffff803`63a26f83     : ffffcb00`00000000 00000000`00000000 00000000`00000000 00000000`00000000 : nt!KiBugCheckDispatch+0x69';
const KV_NVLDDMKM = 'ffff8a0c`5c2f7090 fffff803`6b1a1234     : 00000000`00000000 00000000`00000000 00000000`00000000 00000000`00000000 : nvlddmkm+0x1a1234';

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
      symbol: ': 00000000`0000000a 00000000`00000010 00000000`00000002 00000000`00000000 : nt!KiExecuteAllDpcs+0x8ca'
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
    'STACK_TEXT:  ',
    'fffff800`3231e760 fffff800`9fb6d956     : 00000000`0000000a 00000000`00000010 00000000`00000002 00000000`00000000 : nt!KiExecuteAllDpcs+0x8ca',
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

test('parseStackText reads the call site of real STACK_TEXT lines, including module+offset frames', () => {
  const frames = parseStackText(['', KV_KEBUGCHECK, KV_DISPATCH, KV_NVLDDMKM, ''].join('\n'));
  assert.deepEqual(frames, [
    { address: 'ffff8a0c`5c2f6f48', module: 'nt', function: 'KeBugCheckEx', offset: undefined },
    { address: 'ffff8a0c`5c2f6f50', module: 'nt', function: 'KiBugCheckDispatch', offset: '0x69' },
    { address: 'ffff8a0c`5c2f7090', module: 'nvlddmkm', function: undefined, offset: '0x1a1234' }
  ]);
  // kv header line and trap-frame annotations are not frames / not part of the symbol.
  const kv = parseStackText([
    'Child-SP          RetAddr               : Args to Child                                                           : Call Site',
    'ffff8a0c`5c2f71d0 fffff803`63a2b5a9     : 00000000`00000000 00000000`00000000 00000000`00000000 00000000`00000000 : nt!KiPageFault+0x463 (TrapFrame @ ffff8a0c`5c2f71d0)'
  ].join('\n'));
  assert.deepEqual(kv, [
    { address: 'ffff8a0c`5c2f71d0', module: 'nt', function: 'KiPageFault', offset: '0x463' }
  ]);
});

test('parseWinDbgOutput resolves a real STACK_TEXT block and omits an empty one', () => {
  const analyze = (stackLines) => [
    'DRIVER_IRQL_NOT_LESS_OR_EQUAL (d1)',
    'BUGCHECK_CODE:  d1',
    '',
    'STACK_TEXT:  ',
    ...stackLines,
    '',
    '',
    'SYMBOL_NAME:  nvlddmkm+1a1234',
    '',
    'MODULE_NAME: nvlddmkm'
  ].join('\n');
  const parsed = parseWinDbgOutput(analyze([KV_KEBUGCHECK, KV_DISPATCH, KV_NVLDDMKM]));
  assert.deepEqual(parsed.callStack.map(frame => `${frame.module}!${frame.function ?? ''}+${frame.offset ?? ''}`), [
    'nt!KeBugCheckEx+',
    'nt!KiBugCheckDispatch+0x69',
    'nvlddmkm!+0x1a1234'
  ]);
  assert.equal(Object.hasOwn(parseWinDbgOutput(analyze([])), 'callStack'), false);
});

test('structured kv-style frames keep only the call site after the last " : "', () => {
  const fields = mapStructuredSignalToReport({
    stackFrames: [
      { sp: 'ffff8a0c`5c2f6f48', ret_addr: 'fffff803`63a2b5a9', symbol: ': 00000000`0000000a 00000000`00000010 00000000`00000002 00000000`00000000 : nt!KeBugCheckEx' },
      { sp: 'ffff8a0c`5c2f7090', ret_addr: 'fffff803`6b1a1234', symbol: ': 00000000`00000000 00000000`00000000 00000000`00000000 00000000`00000000 : nvlddmkm+0x1a1234' }
    ]
  });
  assert.deepEqual(fields.callStack, [
    { address: 'ffff8a0c`5c2f6f48', module: 'nt', function: 'KeBugCheckEx', offset: undefined },
    { address: 'ffff8a0c`5c2f7090', module: 'nvlddmkm', function: undefined, offset: '0x1a1234' }
  ]);
});

test('an empty or unresolved parsed stack never overrides the structured call stack', () => {
  const structured = mapStructuredSignalToReport({
    stackFrames: [
      { sp: 'ffff8a0c`5c2f6f48', symbol: 'nt!KeBugCheckEx' },
      { sp: 'ffff8a0c`5c2f6f50', symbol: 'nt!KiBugCheckDispatch+0x69' }
    ]
  });
  const expected = ['nt!KeBugCheckEx', 'nt!KiBugCheckDispatch'];
  const names = report => report.callStack.map(frame => `${frame.module}!${frame.function}`);

  assert.deepEqual(names(mergeReportWithWinDbgFields({ summary: 'x' }, structured, { callStack: [] })), expected);
  assert.deepEqual(names(mergeReportWithWinDbgFields({ summary: 'x' }, structured, {
    callStack: [{ address: 'ffff8a0c`5c2f6f48', module: 'unknown', function: undefined, offset: undefined }]
  })), expected);

  // A resolved parsed stack (the full STACK_TEXT) still wins.
  const parsed = { callStack: parseStackText([KV_KEBUGCHECK, KV_DISPATCH, KV_NVLDDMKM].join('\n')) };
  const merged = mergeReportWithWinDbgFields({ summary: 'x' }, structured, parsed);
  assert.equal(merged.callStack.length, 3);
  assert.equal(merged.callStack[2].module, 'nvlddmkm');
});
