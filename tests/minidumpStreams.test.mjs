import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { transform } from 'rolldown/experimental';

// TypeScript 7 removed transpileModule from its JS API, so tests load .ts
// sources through rolldown's oxc transform (already a vite dependency).
async function loadMinidumpParser() {
  const source = await fs.readFile(new URL('../utils/minidumpStreams.ts', import.meta.url), 'utf8');
  const result = await transform('minidumpStreams.ts', source);
  if (result.errors?.length) {
    throw new Error(`Failed to transform minidumpStreams.ts: ${result.errors[0]}`);
  }
  const encoded = Buffer.from(result.code, 'utf8').toString('base64');
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

test('minidump module names are reduced to their bare filename', async () => {
  const { MinidumpParser, MinidumpStreamType } = await loadMinidumpParser();
  const nameRva = 0x80;
  const fullName = 'C:\\Windows\\System32\\ntoskrnl.exe';
  const buffer = new ArrayBuffer(nameRva + 4 + fullName.length * 2);
  const view = new DataView(buffer);

  view.setUint32(0, 0x504d444d, true); // MDMP
  view.setUint32(8, 1, true); // stream count
  view.setUint32(12, 0x20, true); // stream directory RVA

  view.setUint32(0x20, MinidumpStreamType.ModuleListStream, true);
  view.setUint32(0x24, 4 + 108, true);
  view.setUint32(0x28, 0x30, true);

  view.setUint32(0x30, 1, true); // number of modules
  const moduleOffset = 0x34;
  view.setBigUint64(moduleOffset, 0xfffff80339a00000n, true); // base address
  view.setUint32(moduleOffset + 8, 0x800000, true); // size
  view.setUint32(moduleOffset + 20, nameRva, true); // name RVA

  // MINIDUMP_STRING: u32 byte length, then UTF-16LE characters
  view.setUint32(nameRva, fullName.length * 2, true);
  for (let i = 0; i < fullName.length; i++) {
    view.setUint16(nameRva + 4 + i * 2, fullName.charCodeAt(i), true);
  }

  const [module] = new MinidumpParser(buffer).getModules();
  assert.equal(module.name, 'ntoskrnl.exe');
  assert.equal(module.baseAddress, 0xfffff80339a00000n);
});
