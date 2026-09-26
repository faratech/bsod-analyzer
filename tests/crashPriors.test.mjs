import test from 'node:test';
import assert from 'node:assert/strict';
import { createCrashPriors, extractPromptSignal, formatPriorContext, normalizePriorCode } from '../server/crashPriors.js';
import { WINDBG_OUTPUT_MARKER, WINDBG_PREFIX, wrapWithEvidence } from '../shared/promptTemplates.js';

const rows = [
  { kind: 'bugcheck', key: '0x116', payload: JSON.stringify({
    n: 508, share_of_all: 0.0328, corpus_size: 15474, name: 'VIDEO_TDR_FAILURE', hardware_share: 0, first_minute_share: 0.049,
    top_modules: [{ image: 'nvlddmkm.sys', share: 0.925 }, { image: 'igdkmdn64.sys', share: 0.03 }, { image: 'unknown_image', share: 0.002 }]
  }) },
  { kind: 'image', key: 'nvlddmkm.sys', payload: JSON.stringify({
    n: 1140, corpus_size: 15474, hardware_share: 0, manufacturer: 'NVIDIA',
    top_stop_codes: [{ code: '0x116', share: 0.412 }, { code: '0x133', share: 0.154 }, { code: '0x141', share: 0.132 }], top_versions: []
  }) },
  { kind: 'bugcheck', key: 'bad', payload: '{not json' }
];
const reader = (value) => ({ read: async () => value });

test('context frames population priors and omits pseudo-modules and empty lists', async () => {
  const priors = createCrashPriors({ reader: reader(rows) });
  const text = await priors.contextFor({ bugcheckCode: '0x00000116', imageName: 'NVLDDMKM.SYS' });
  assert.match(text, /^\*\*Corpus context \(statistics from 15,474 prior WinDBG analyses — priors, not evidence about this dump\):\*\*/);
  assert.match(text, /Stop code 0x116 VIDEO_TDR_FAILURE: 3% of analyses; faulting module most often nvlddmkm\.sys \(93%\), igdkmdn64\.sys \(3%\); judged hardware-caused 0%; 5% within the first minute after boot\./);
  assert.match(text, /nvlddmkm\.sys \(NVIDIA\): 1,140 analyses; usually 0x116 \(41%\), 0x133 \(15%\), 0x141 \(13%\)\./);
  assert.doesNotMatch(text, /unknown_image|versions/);
  assert.ok(text.length <= 1200);
});

test('unknown keys, pseudo-modules and missing input give an empty context', async () => {
  const priors = createCrashPriors({ reader: reader(rows) });
  assert.equal(await priors.contextFor({ bugcheckCode: '0xDEAD', imageName: 'foo.sys' }), '');
  assert.equal(await priors.contextFor({ imageName: 'Unknown_Image' }), '');
  assert.equal(await priors.contextFor({}), '');
  assert.equal(formatPriorContext({}), '');
});

test('a slow or failing priors file never blocks the analysis', async () => {
  const logger = { warn() {} };
  const slow = createCrashPriors({ reader: { read: () => new Promise(r => setTimeout(() => r(rows), 500)) }, timeoutMs: 20, logger });
  const started = Date.now();
  assert.equal(await slow.contextFor({ bugcheckCode: '0x116' }), '');
  assert.ok(Date.now() - started < 300);
  const failing = createCrashPriors({ reader: { read: async () => { throw new Error('HTTP 403'); } }, logger });
  assert.equal(await failing.contextFor({ bugcheckCode: '0x116' }), '');
});

test('stop codes normalize to the priors key form', () => {
  assert.equal(normalizePriorCode('0x00000116'), '0x116');
  assert.equal(normalizePriorCode('0xc000021a'), '0xC000021A');
  assert.equal(normalizePriorCode('nope'), null);
});

test('extractPromptSignal reads the structured JSON of a web WinDBG prompt, then raw fields', () => {
  const signal = { schema: 'windbg_crash_signal_v1', bugcheck: { name: 'VIDEO_TDR_FAILURE', code: '0x116' }, crash: { imageName: 'nvlddmkm.sys', moduleName: 'nvlddmkm' } };
  const evidence = `**File Information:**\n- Filename: x.dmp\n\n${WINDBG_OUTPUT_MARKER}\nRelevant structured JSON extracted from the WinDBG API result.\n\`\`\`json\n${JSON.stringify(signal, null, 2)}\n\`\`\``;
  assert.deepEqual(extractPromptSignal(wrapWithEvidence(WINDBG_PREFIX, evidence)), { bugcheckCode: '0x116', imageName: 'nvlddmkm.sys' });

  const raw = `${WINDBG_OUTPUT_MARKER}\n\`\`\`\nBUGCHECK_CODE:  116\nIMAGE_NAME:  nvlddmkm.sys\n\`\`\``;
  assert.deepEqual(extractPromptSignal(raw), { bugcheckCode: '0x116', imageName: 'nvlddmkm.sys' });
  assert.deepEqual(extractPromptSignal('no evidence here'), { bugcheckCode: null, imageName: null });
});
