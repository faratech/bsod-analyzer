import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { transform } from 'rolldown/experimental';
import { FORCED_CRASH_GUIDANCE, LOCAL_DUMP_PREFIX, WINDBG_PREFIX, PROMPT_SHAPES } from '../shared/promptTemplates.js';
import { SYSTEM_INSTRUCTION, SYSTEM_INSTRUCTION_STREAM } from '../server/bsodAi.js';

async function loadForcedCrash() {
  const source = await fs.readFile(new URL('../utils/forcedCrash.ts', import.meta.url), 'utf8');
  const { code } = await transform('forcedCrash.ts', source);
  return import(`data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`);
}

test('both analysis prompts carry the forced-crash guidance, and it never depends on the dump', () => {
  assert.ok(LOCAL_DUMP_PREFIX.includes(FORCED_CRASH_GUIDANCE));
  assert.ok(WINDBG_PREFIX.includes(FORCED_CRASH_GUIDANCE));
  // The prefixes are shared by every dump (and the prompt cache): no placeholders may have leaked in.
  assert.doesNotMatch(FORCED_CRASH_GUIDANCE, /undefined|\$\{|\[object/);
  // The server's prompt validator still recognizes both shapes.
  for (const shape of PROMPT_SHAPES) {
    const prefix = shape.type === 'windbg' ? WINDBG_PREFIX : LOCAL_DUMP_PREFIX;
    assert.ok(prefix.startsWith(shape.startsWith));
    for (const marker of shape.required.filter(m => !m.includes('WinDBG Analysis Output'))) assert.ok(prefix.includes(marker), marker);
  }
});

test('the guidance says what the dump does and does not show', () => {
  for (const code of ['0x1C8', '0xE2', 'MANUALLY_INITIATED_POWER_BUTTON_HOLD', 'MANUALLY_INITIATED_CRASH']) assert.ok(FORCED_CRASH_GUIDANCE.includes(code), code);
  assert.match(FORCED_CRASH_GUIDANCE, /records the forced action, NOT the problem that came first/);
  assert.match(FORCED_CRASH_GUIDANCE, /root cause is NOT established by this dump/);
  assert.match(FORCED_CRASH_GUIDANCE, /Unknown \(not captured in this dump\)/);
  assert.match(FORCED_CRASH_GUIDANCE, /Do not blame the power button/);
  assert.match(FORCED_CRASH_GUIDANCE, /unconfirmed lead/);
  assert.match(FORCED_CRASH_GUIDANCE, /Kernel-Power \(Event ID 41\)/);
  assert.match(FORCED_CRASH_GUIDANCE, /dump never finished writing/, 'an earlier crash that was not captured is named too');
});

test('BSOD AI knows a forced crash is not a fault, in both reply formats', () => {
  for (const instruction of [SYSTEM_INSTRUCTION, SYSTEM_INSTRUCTION_STREAM]) {
    assert.match(instruction, /0x1C8 MANUALLY_INITIATED_POWER_BUTTON_HOLD/);
    assert.match(instruction, /original cause is not in the dump/);
    assert.match(instruction, /Do not name a culprit or blame the power button/);
  }
});

test('forced-crash parameters are decoded from Microsoft\'s definitions', async () => {
  const { isForcedCrash, describeForcedCrashParameters, describeForcedCrash } = await loadForcedCrash();
  for (const code of [0xE2, 0x1C8, 0x11C8, 0x21C8, 0xDEADDEAD]) assert.equal(isForcedCrash(code), true, code.toString(16));
  for (const code of [0x1A, 0xD1, 0x9F, 0x124, 0x1C7, 0x1C9]) assert.equal(isForcedCrash(code), false, code.toString(16));

  const hold = describeForcedCrashParameters(0x1C8, [7012n, 0xFFFFF80012345678n, 0n, 0n]);
  assert.match(hold, /Arg1: Time the power button was held, in milliseconds \(7012, about 7\.0 seconds\)/);
  assert.match(hold, /nt!_POP_POWER_BUTTON_TRIAGE_BLOCK \(0xfffff80012345678\)/);
  assert.match(hold, /Arg3: Reserved/);
  assert.match(hold, /hung or stopped responding/);
  assert.match(hold, /Do not treat it as the cause/);

  const keyboard = describeForcedCrashParameters(0xE2, [0n, 0n, 0n, 0n]);
  assert.match(keyboard, /No parameters/);
  assert.match(keyboard, /Scroll Lock/);

  // Other codes are left to the regular decoder.
  assert.equal(describeForcedCrashParameters(0xD1, [1n, 2n, 3n, 4n]), undefined);
  assert.match(describeForcedCrash(0x1C8), /power button/);
  assert.equal(describeForcedCrash(0x1A), undefined);
});
