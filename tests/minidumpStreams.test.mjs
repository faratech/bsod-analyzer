import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';

async function loadMinidumpParser() {
  const source = await fs.readFile(new URL('../utils/minidumpStreams.ts', import.meta.url), 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2020,
      target: ts.ScriptTarget.ES2020
    }
  });
  const encoded = Buffer.from(transpiled.outputText, 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
}

test('minidump thread context descriptor reads DataSize before RVA', async () => {
  const { MinidumpParser, MinidumpStreamType } = await loadMinidumpParser();
  const contextRva = 0x80;
  const contextSize = 0x4d0;
  const buffer = new ArrayBuffer(contextRva + contextSize);
  const view = new DataView(buffer);

  view.setUint32(0, 0x504d444d, true); // MDMP
  view.setUint32(8, 1, true); // stream count
  view.setUint32(12, 0x20, true); // stream directory RVA

  view.setUint32(0x20, MinidumpStreamType.ThreadListStream, true);
  view.setUint32(0x24, 4 + 48, true);
  view.setUint32(0x28, 0x40, true);

  view.setUint32(0x40, 1, true); // number of threads
  const threadOffset = 0x44;
  view.setUint32(threadOffset, 1234, true);
  view.setUint32(threadOffset + 40, contextSize, true);
  view.setUint32(threadOffset + 44, contextRva, true);

  view.setBigUint64(contextRva + 0xf8, 0x1111222233334444n, true);
  view.setBigUint64(contextRva + 0x98, 0x5555666677778888n, true);
  view.setBigUint64(contextRva + 0xa0, 0x9999aaaabbbbccccn, true);

  const [thread] = new MinidumpParser(buffer).getThreads();
  assert.equal(thread.instructionPointer, 0x1111222233334444n);
  assert.equal(thread.stackPointer, 0x5555666677778888n);
  assert.equal(thread.framePointer, 0x9999aaaabbbbccccn);
});
