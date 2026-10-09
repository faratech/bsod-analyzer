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

test('ai-fallback stats are recorded only for a dump the session uploaded (issue #149)', () => {
  const statsCalls = calls(handler, 'recordStats');
  assert.equal(statsCalls.length, 2, 'cache-hit and fresh paths');
  for (const call of statsCalls) {
    const guard = find(handler, node => node.type === 'IfStatement'
      && node.consequent.start <= call.start && call.end <= node.consequent.end)
      .map(({ node }) => text(node.test));
    assert.ok(guard.some(test => /ownedFileHash/.test(test)), `recordStats must be guarded by ownedFileHash: ${guard}`);
    assert.equal(text(property(call.arguments[0], 'fileHash')), 'fileHash');
  }
});
