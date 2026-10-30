import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rolldown } from 'rolldown';

// Issue #331: how one file's analysis outcome lands on its DumpFile state
// (hooks/useAnalysis.tsx). The WinDBG result kept after an AI-only failure
// lives only while the file is in ERROR, so memory stays bounded.
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const bundle = await rolldown({ input: path.join(root, 'utils', 'fileResult.ts'), logLevel: 'silent' });
const { output } = await bundle.generate({ format: 'esm' });
const { applyFileResult } = await import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`);

const kept = { analysisText: 'BUGCHECK_CODE: d1', fileHash: 'a'.repeat(64), completedAt: 1 };
const file = (extra = {}) => ({ id: 'f1', file: {}, dumpType: 'minidump', status: 'ANALYZING', ...extra });

test('an AI-only failure keeps the WinDBG result on the file (issue #331)', () => {
  const next = applyFileResult(file(), { id: 'f1', status: 'ERROR', error: 'AI busy', windbgResult: kept });
  assert.equal(next.status, 'ERROR');
  assert.equal(next.error, 'AI busy');
  assert.equal(next.windbgResult, kept);
});

test('a success or a failure without a WinDBG result drops the kept one (issue #331)', () => {
  const analyzed = applyFileResult(file({ windbgResult: kept }), { id: 'f1', status: 'ANALYZED', report: { summary: 's' }, analysisMethod: 'windbg' });
  assert.equal(analyzed.status, 'ANALYZED');
  assert.deepEqual(analyzed.report, { summary: 's' });
  assert.equal(analyzed.windbgResult, undefined);
  assert.equal(analyzed.cached, false);

  const failedAgain = applyFileResult(file({ windbgResult: kept }), { id: 'f1', status: 'ERROR', error: 'upload failed' });
  assert.equal(failedAgain.windbgResult, undefined);
  assert.equal(failedAgain.error, 'upload failed');
  assert.equal(applyFileResult(file(), { id: 'f1', status: 'ERROR' }).error, 'Unknown analysis error');
});
