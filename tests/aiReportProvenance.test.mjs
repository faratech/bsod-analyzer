import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

// server.js has no unit tests; pin how /api/gemini/generateContent and the
// external API path decide what a report may be linked to (issues #145,
// #147, #149), the way tests/aiHandlerScope.test.mjs pins the refund path.
const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));
const source = readFileSync(SERVER, 'utf8');
const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });

function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'range') continue;
    const value = node[key];
    if (Array.isArray(value)) value.forEach(child => walk(child, visit, node));
    else if (value && typeof value.type === 'string') walk(value, visit, node);
  }
}

function find(root, predicate) {
  const found = [];
  walk(root, (node, parent) => { if (predicate(node, parent)) found.push({ node, parent }); });
  return found;
}

const text = node => source.slice(node.start, node.end);

function routeHandler(path) {
  return find(ast, node => node.type === 'CallExpression' && node.arguments[0]?.value === path)
    .map(({ node }) => node.arguments.at(-1))[0];
}

function calls(root, name) {
  return find(root, node => node.type === 'CallExpression' && node.callee?.name === name).map(({ node }) => node);
}

function property(objectNode, key) {
  return objectNode.properties.find(prop => prop.key?.name === key)?.value;
}

const handler = routeHandler('/api/gemini/generateContent');
const apiReport = find(ast, node => node.type === 'FunctionDeclaration' && node.id?.name === 'generateAIReportFromWinDBG')[0].node;

test('only a server-rebuilt prompt keys the shared per-file cache entry (issue #145)', () => {
  const cacheKey = find(handler, node => node.type === 'VariableDeclarator' && node.id.name === 'cacheKey')[0]?.node;
  assert.ok(cacheKey, 'cacheKey must be declared once');
  assert.equal(cacheKey.init.type, 'ConditionalExpression');
  assert.equal(text(cacheKey.init.test), 'ownedEvidence');
  assert.equal(text(cacheKey.init.consequent), 'fileHash');

  const rebuild = find(handler, node => node.type === 'AssignmentExpression' && node.left.name === 'serverPrompt')[0]?.node;
  assert.equal(rebuild?.right.callee?.name, 'buildServerWinDbgPrompt', 'the WinDBG prompt is rebuilt server-side');
});

test('corpus rows link to the dump and job only for the server-rebuilt prompt (issue #147)', () => {
  const [record] = calls(handler, 'recordAiReport');
  const entry = record.arguments[0];
  assert.equal(text(property(entry, 'fileHash')), 'ownedEvidence ? fileHash : undefined');
  assert.equal(text(property(entry, 'jobId')), 'ownedEvidence?.upstreamJobId');
  assert.equal(text(property(entry, 'promptVerified')), 'Boolean(ownedEvidence)');
  assert.match(text(property(entry, 'source')), /^ownedEvidence \? 'windbg'/);

  const [apiRecord] = calls(apiReport, 'recordAiReport');
  assert.equal(text(property(apiRecord.arguments[0], 'promptVerified')), 'true');
});

test('the API path keeps the caller-supplied file name out of the prompt (issue #145)', () => {
  const [evidence] = calls(apiReport, 'buildWinDbgEvidence');
  assert.equal(text(property(evidence.arguments[0], 'fileName')), 'SERVER_PROMPT_FILE_NAME');
});

// The exact guard shape: `validation.promptType === 'local' && ownedFileHash`.
// A substring match accepted `!ownedFileHash`, `... || ownedFileHash` and any
// other condition mentioning the name (issue #262).
function assertOwnedLocalGuard(node, where) {
  assert.equal(node?.type, 'LogicalExpression', `${where}: guard must be a logical expression, got ${node && text(node)}`);
  assert.equal(node.operator, '&&', `${where}: guard must AND the conditions, got ${text(node)}`);
  const operands = [node.left, node.right];
  const owned = operands.filter(operand => operand.type === 'Identifier' && operand.name === 'ownedFileHash');
  assert.equal(owned.length, 1, `${where}: guard must test the bare ownedFileHash (no negation): ${text(node)}`);
  const local = operands.find(operand => operand !== owned[0]);
  assert.equal(local.type, 'BinaryExpression', `${where}: ${text(node)}`);
  assert.equal(local.operator, '===', `${where}: ${text(node)}`);
  assert.equal(text(local.left), 'validation.promptType', `${where}: ${text(node)}`);
  assert.equal(local.right.value, 'local', `${where}: ${text(node)}`);
}

test('ai-fallback stats are recorded only for a dump the session uploaded (issue #149)', () => {
  const statsCalls = calls(handler, 'recordStats');
  assert.equal(statsCalls.length, 2, 'cache-hit and fresh paths');
  for (const call of statsCalls) {
    const guards = find(handler, node => node.type === 'IfStatement'
      && node.consequent.start <= call.start && call.end <= node.consequent.end)
      .map(({ node }) => node)
      .sort((a, b) => b.start - a.start);
    assert.ok(guards.length > 0, 'recordStats must sit inside an if');
    // The innermost if around the call is the ownership guard.
    assertOwnedLocalGuard(guards[0].test, `recordStats at ${call.start}`);
    assert.equal(text(property(call.arguments[0], 'fileHash')), 'fileHash');
    assert.equal(text(property(call.arguments[0], 'source')), "'ai-fallback'");
  }
});

test('ownedFileHash is true only after sessionOwnsHash proves the upload (issues #40, #149)', () => {
  const declarators = find(handler, node => node.type === 'VariableDeclarator' && node.id.name === 'ownedFileHash');
  assert.equal(declarators.length, 1);
  assert.equal(declarators[0].node.init?.value, false, 'ownedFileHash must default to false');
  const assignments = find(handler, node => node.type === 'AssignmentExpression' && node.left.name === 'ownedFileHash')
    .map(({ node }) => node);
  assert.equal(assignments.length, 1, 'ownedFileHash is assigned in exactly one place');
  assert.equal(assignments[0].right.type, 'CallExpression');
  assert.equal(assignments[0].right.callee.name, 'sessionOwnsHash');
  assert.deepEqual(assignments[0].right.arguments.map(text), ['req.sessionId', 'fileHash', 'fileHandle']);
});
