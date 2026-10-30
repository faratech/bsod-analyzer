import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

// Issue #305: the AI deadline (server/aiDeadline.js, #255) must start when the
// request arrives, not when generateAIContent() starts. The awaits before the
// chain (owned WinDBG evidence, the quota reservation, prior context, the
// external poll's cache read and upstream fetch) otherwise run on top of the
// 90 s budget and the response lands past Cloudflare's 100 s timeout.
const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));
const ast = acorn.parse(readFileSync(SERVER, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value.type === 'string') walk(value, visit);
  }
}

function calleeName(call) {
  const c = call.callee;
  if (c.type === 'Identifier') return c.name;
  if (c.type === 'MemberExpression' && c.property.type === 'Identifier') {
    const object = c.object.type === 'Identifier' ? `${c.object.name}.` : '';
    return `${object}${c.property.name}`;
  }
  return null;
}

function calls(root, name) {
  const found = [];
  walk(root, node => {
    if (node.type === 'CallExpression' && calleeName(node) === name) found.push(node);
  });
  return found.sort((a, b) => a.start - b.start);
}

function route(method, path) {
  const call = calls(ast, `app.${method}`).find(c => c.arguments[0]?.value === path);
  assert.ok(call, `route ${path} not found`);
  return call.arguments.at(-1);
}

function fn(name) {
  let found;
  walk(ast, node => {
    if (node.type === 'FunctionDeclaration' && node.id?.name === name) found = node;
  });
  assert.ok(found, `function ${name} not found`);
  return found;
}

const hasDeadlineProp = arg => arg?.type === 'ObjectExpression'
  && arg.properties.some(p => p.key?.name === 'deadline');

function assertDeadlineFirst(root, label, laterCalls) {
  const created = calls(root, 'createAIDeadline')[0];
  assert.ok(created, `${label} creates no AI deadline`);
  for (const name of laterCalls) {
    const later = calls(root, name)[0];
    assert.ok(later, `${label} no longer calls ${name}`);
    assert.ok(created.start < later.start, `${label} creates its AI deadline after ${name}`);
  }
}

test('every generateAIContent call passes the request deadline', () => {
  const all = calls(ast, 'generateAIContent');
  assert.ok(all.length >= 2);
  for (const call of all) assert.ok(hasDeadlineProp(call.arguments[1]), `generateAIContent call at ${call.start} passes no deadline`);
});

test('/api/gemini/generateContent starts its deadline before evidence, quota and prior context', () => {
  assertDeadlineFirst(route('post', '/api/gemini/generateContent'), 'generateContent',
    ['loadOwnedWinDbgEvidence', 'quotaLedger.reserve', 'priorContextFor', 'generateAIContent']);
});

test('generateAIReportFromWinDBG takes its caller\'s deadline and starts one before its own awaits', () => {
  const body = fn('generateAIReportFromWinDBG');
  assertDeadlineFirst(body, 'generateAIReportFromWinDBG', ['getCachedAnalysis', 'priorContextFor', 'generateAIContent']);
  const src = readFileSync(SERVER, 'utf8').slice(body.start, body.end);
  assert.match(src, /options\.deadline/, 'a caller\'s deadline is ignored');
});

test('the external status poll starts its deadline on arrival and hands it to the report', () => {
  const handler = route('get', '/api/analyze/status/:uid');
  assertDeadlineFirst(handler, 'status poll', ['externalJobResolver.resolve']);
  assert.ok(hasDeadlineProp(calls(handler, 'externalJobResolver.resolve')[0].arguments[1]), 'resolve gets no deadline');
  const report = calls(fn('generateExternalReport'), 'generateAIReportFromWinDBG')[0];
  assert.ok(hasDeadlineProp(report.arguments.at(-1)), 'generateExternalReport drops the deadline');
});
