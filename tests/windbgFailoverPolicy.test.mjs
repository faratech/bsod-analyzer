import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as acorn from 'acorn';
import { transform } from 'rolldown/experimental';
import {
  DEFAULT_LARGE_DUMP_SAMPLE_BYTES,
  getLargeDumpSampleRanges,
  shouldUseLightweightAiFailover
} from '../shared/windbgFailoverPolicy.js';

test('large dump WinDBG outage uses lightweight AI failover policy', () => {
  const fullLocalLimit = 5 * 1024 * 1024;

  assert.equal(shouldUseLightweightAiFailover(fullLocalLimit, fullLocalLimit), false);
  assert.equal(shouldUseLightweightAiFailover(fullLocalLimit + 1, fullLocalLimit), true);
});

test('large dump failover samples head and tail without reading full file', () => {
  const fileSize = 100 * 1024 * 1024;
  const ranges = getLargeDumpSampleRanges(fileSize);
  const totalBytes = ranges.reduce((sum, range) => sum + range.end - range.start, 0);

  assert.deepEqual(ranges.map(range => range.label), ['head', 'tail']);
  assert.equal(ranges[0].start, 0);
  assert.equal(ranges[1].end, fileSize);
  assert.ok(totalBytes <= DEFAULT_LARGE_DUMP_SAMPLE_BYTES);
  assert.ok(ranges[0].end <= ranges[1].start);
});

test('small dump failover policy keeps full local analysis available', () => {
  const fileSize = 512 * 1024;
  assert.deepEqual(getLargeDumpSampleRanges(fileSize), [
    { label: 'full', start: 0, end: fileSize }
  ]);
});

// Wiring (issue #265): the policy above only matters if the pipeline in
// services/geminiProxy.ts gates the right branch on it. A regex count passed
// with the gates inverted, so read the structure instead: types stripped by
// rolldown's oxc transform (a vite dependency), then parsed with acorn.
async function proxyAst() {
  const source = await fs.readFile(new URL('../services/geminiProxy.ts', import.meta.url), 'utf8');
  const { code, errors } = await transform('geminiProxy.ts', source);
  assert.equal(errors?.length ?? 0, 0, 'geminiProxy.ts must transform cleanly');
  return { code, ast: acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' }) };
}

function walk(node, visit, ancestors = []) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, ancestors);
  const next = [...ancestors, node];
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) value.forEach(child => walk(child, visit, next));
    else if (value && typeof value.type === 'string' && key !== 'type') walk(value, visit, next);
  }
}

function findAll(root, predicate) {
  const found = [];
  walk(root, (node, ancestors) => { if (predicate(node)) found.push({ node, ancestors }); });
  return found;
}

const within = (outer, inner) => outer && outer.start <= inner.start && inner.end <= outer.end;

test('WinDBG-down failover wiring: both failure branches route large dumps to the lightweight AI fallback', async () => {
  // A large dump must never be rejected outright, or sent to the full local
  // parser, just because WinDBG is down (the legacy "WinDBG analysis is
  // required for large dump files" rejection).
  const { code, ast } = await proxyAst();
  const text = node => code.slice(node.start, node.end);
  assert.doesNotMatch(code, /WinDBG analysis is required for large dump files/);

  const declarations = findAll(ast, node => node.type === 'VariableDeclarator' && node.id.name === 'useLightweightAiFailover');
  assert.equal(declarations.length, 1);
  assert.equal(declarations[0].node.init?.value, false, 'the failover flag starts false');

  const assignments = findAll(ast, node => node.type === 'AssignmentExpression' && node.left.name === 'useLightweightAiFailover');
  assert.equal(assignments.length, 2, 'set on the returned-failure and thrown-error branches only');

  const branches = [];
  for (const { node, ancestors } of assignments) {
    assert.equal(node.operator, '=');
    assert.equal(node.right.value, true, 'a WinDBG failure can only turn the failover on');
    const gate = [...ancestors].reverse().find(a => a.type === 'IfStatement');
    assert.ok(gate, 'the assignment must be gated');
    assert.ok(within(gate.consequent, node), 'the flag is set in the gate\'s then-branch, not its else');
    // Exactly the policy call: no negation, no `false &&`, no extra operand.
    assert.equal(gate.test.type, 'CallExpression', `gate must be the bare policy call: ${text(gate.test)}`);
    assert.equal(gate.test.callee.name, 'shouldUseLightweightAiFailover');
    assert.deepEqual(gate.test.arguments.map(text), ['dumpFile.file.size', 'FULL_LOCAL_ANALYSIS_LIMIT']);
    assert.ok(gate.alternate, 'small dumps keep the local-analysis else-branch');
    assert.match(text(gate.alternate), /Falling back to local analysis/);

    // The failure that reaches the failover report is recorded first.
    const block = ancestors[ancestors.indexOf(gate) - 1];
    const failureSet = findAll(block, n => n.type === 'AssignmentExpression' && n.left.name === 'windbgFailure');
    assert.ok(failureSet.some(({ node: n }) => n.end <= gate.start), 'windbgFailure is set before the gate');

    branches.push(ancestors.some(a => a.type === 'CatchClause') ? 'thrown' : 'returned');
  }
  assert.deepEqual(branches.sort(), ['returned', 'thrown']);

  // The flag diverts to the lightweight report before any full local parsing.
  const uses = findAll(ast, node => node.type === 'IfStatement'
    && node.test.type === 'Identifier' && node.test.name === 'useLightweightAiFailover');
  assert.equal(uses.length, 1, 'the flag is consumed by a bare `if (useLightweightAiFailover)`');
  const use = uses[0].node;
  const report = findAll(use.consequent, n => n.type === 'CallExpression' && n.callee.name === 'generateLargeDumpAiFailoverReport');
  assert.equal(report.length, 1);
  // The run's cancel signal (issue #235) is forwarded so a cancelled run aborts the report request.
  assert.deepEqual(report[0].node.arguments.map(text), ['dumpFile', 'fileLabel', 'windbgFailure', 'options?.signal']);
  assert.ok(findAll(use.consequent, n => n.type === 'ReturnStatement').length > 0, 'the failover report is returned');
  for (const { node } of assignments) assert.ok(node.end < use.start, 'gates run before the flag is read');
  const localParse = findAll(ast, n => n.type === 'CallExpression' && n.callee.name === 'extractPrintableStrings');
  assert.ok(localParse.some(({ node }) => node.start > use.end), 'the full local parse comes after the failover return');
});
