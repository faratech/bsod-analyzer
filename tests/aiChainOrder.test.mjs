import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import * as aiProvider from '../services/aiProvider.js';
import { readEnvSwitches, warnRetiredEnv } from '../server/envConfig.js';
import { createProviderQuotaStore } from '../server/quotaStore.js';

// Issue #323: Gemini 4 Argon is no longer free, so its legs (free id, then
// the paid id) are retired and Experiential gpt-6-luna is the first leg of the
// DeepSeek chain. server.js has no unit tests, so the leg order is read from
// its syntax tree, like tests/aiDeadlineWiring.test.mjs.
const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));
const source = readFileSync(SERVER, 'utf8');
const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value.type === 'string') walk(value, visit);
  }
}

function fn(name) {
  let found;
  walk(ast, node => {
    if (node.type === 'FunctionDeclaration' && node.id?.name === name) found = node;
  });
  assert.ok(found, `function ${name} not found`);
  return found;
}

const PROVIDER_CALLS = new Set([
  'generateExperientialContent',
  'generateOpenAIContent',
  'generateDeepSeekContent',
  'generateOpenRouterContent'
]);

// The provider adapters the DeepSeek branches of generateAIContent call, in
// source order (each leg is tried in that order and falls through on failure).
function deepSeekLegs() {
  const branches = [];
  walk(fn('generateAIContent'), node => {
    if (node.type !== 'IfStatement') return;
    const t = node.test;
    if (t.type === 'BinaryExpression' && t.left.name === 'provider' && t.right.value === 'deepseek') branches.push(node.consequent);
  });
  assert.ok(branches.length > 0, 'generateAIContent has no DeepSeek branch');
  const legs = [];
  for (const branch of branches) walk(branch, node => {
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && PROVIDER_CALLS.has(node.callee.name)) {
      const model = node.arguments[1]?.properties?.find(p => p.key?.name === 'model')?.value;
      legs.push({ name: node.callee.name, model: model?.name, start: node.start });
    }
  });
  return legs.sort((a, b) => a.start - b.start);
}

test('the DeepSeek chain starts with Experiential gpt-6-luna, then OpenAI free, DeepSeek and OpenRouter', () => {
  const legs = deepSeekLegs();
  assert.deepEqual(legs.map(l => l.name), [
    'generateExperientialContent',
    'generateOpenAIContent',
    'generateDeepSeekContent',
    'generateOpenRouterContent'
  ]);
  assert.equal(legs[0].model, 'EXPERIENTIAL_MODEL', 'the Experiential leg must run EXPLABS_MODEL (gpt-6-luna)');
  assert.equal(aiProvider.DEFAULT_EXPERIENTIAL_MODEL, 'gpt-6-luna');
  // The Experiential leg still runs only with the default model.
  assert.match(source, /EXPERIENTIAL_MODEL !== DEFAULT_EXPERIENTIAL_MODEL/);
});

test('no server or provider module keeps an Argon leg, model id or quota key', () => {
  const files = [
    SERVER,
    fileURLToPath(new URL('../services/aiProvider.js', import.meta.url)),
    ...readdirSync(new URL('../server/', import.meta.url))
      .filter(name => name.endsWith('.js'))
      .map(name => fileURLToPath(new URL(`../server/${name}`, import.meta.url)))
  ];
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
      // The retired-variable notice in envConfig names the prefix it ignores.
      .replace(/RETIRED_ENV_PREFIXES[\s\S]*?\];/, '');
    assert.ok(!/argon/i.test(text), `${file} still references Argon`);
  }
  assert.equal(Object.keys(aiProvider).some(name => /argon/i.test(name)), false);
  // The stall scope, per-reservation shard override and minOutputCost served
  // only the Argon legs (#257, #274, #303).
  const store = createProviderQuotaStore({ shards: 2 });
  assert.equal(store.stall, undefined);
  assert.equal(store.isStalled, undefined);
  const limits = { dailyInputLimit: 100, dailyOutputLimit: 100, hourlyInputLimit: 100, hourlyOutputLimit: 100 };
  const capped = store.reserve('experiential-luna', { inputCost: 1, outputCost: 60, minOutputCost: 1, shards: 1, ...limits });
  assert.deepEqual([capped.allowed, capped.reason], [false, 'daily'], 'the store share is 50 of 100; no override may widen or trim it');
});

test('EXPLABS_ARGON_* variables switch nothing on and are only reported as ignored', () => {
  const env = {
    EXPLABS_ARGON_ENABLED: '1',
    EXPLABS_ARGON_PAID_DAILY_INPUT_LIMIT: '1500000',
    EXPLABS_ARGON_TIMEOUT_MS: '40000',
    EXPLABS_API_KEY: 'secret-key'
  };
  const switches = readEnvSwitches(env, { warn: () => assert.fail('a switch parsed an Argon variable') });
  assert.equal(Object.keys(switches).some(name => /argon/i.test(name)), false);

  const warnings = [];
  const ignored = warnRetiredEnv(env, { warn: w => warnings.push(w) });
  assert.deepEqual(ignored, ['EXPLABS_ARGON_ENABLED', 'EXPLABS_ARGON_PAID_DAILY_INPUT_LIMIT', 'EXPLABS_ARGON_TIMEOUT_MS']);
  assert.equal(warnings.length, 1, 'one warning at boot, not one per variable');
  assert.equal(warnings[0].event, 'env.ignored');
  assert.deepEqual(warnings[0].names, ignored);
  // Names only: never a value, and nothing about other EXPLABS_* settings.
  assert.doesNotMatch(JSON.stringify(warnings), /secret-key|1500000|40000/);

  const quiet = [];
  assert.deepEqual(warnRetiredEnv({ EXPLABS_API_KEY: 'k' }, { warn: w => quiet.push(w) }), []);
  assert.equal(quiet.length, 0);
});

test('server.js reports retired variables once at boot', () => {
  const call = /warnRetiredEnv\(process\.env, \{ warn: envWarn \}\)/g;
  assert.equal(source.match(call)?.length, 1);
});
