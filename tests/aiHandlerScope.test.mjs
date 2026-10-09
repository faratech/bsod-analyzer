import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

// A `catch` block is a sibling scope of its `try`, not a child of it. Anything the
// catch reads must therefore be declared in the enclosing function scope. Getting
// this wrong is silent until the failure path actually runs, and then it throws a
// ReferenceError *inside the error handler* — which both swallows the original
// error and skips whatever cleanup the catch existed to perform.
//
// This bit production: the /api/gemini/generateContent quota-refund block read
// quotaKey / estimatedInputTokens / quotaWindowSeconds / quotaRefundCap, all of
// which were declared inside the try. Every upstream AI failure logged
// "ReferenceError: quotaKey is not defined" instead of returning its mapped status,
// and no reservation was ever refunded.

const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));

function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'range') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === 'string') walk(child, visit, node);
      }
    } else if (value && typeof value.type === 'string') {
      walk(value, visit, node);
    }
  }
}

function boundNames(pattern, out) {
  if (!pattern) return;
  switch (pattern.type) {
    case 'Identifier': out.add(pattern.name); break;
    case 'ObjectPattern':
      for (const prop of pattern.properties) {
        boundNames(prop.type === 'RestElement' ? prop.argument : prop.value, out);
      }
      break;
    case 'ArrayPattern':
      for (const el of pattern.elements) boundNames(el, out);
      break;
    case 'AssignmentPattern': boundNames(pattern.left, out); break;
    case 'RestElement': boundNames(pattern.argument, out); break;
    default: break;
  }
}

// Identifiers in "read" position — excludes property names, object literal keys,
// declaration targets, and parameter names.
function readIdentifiers(root) {
  const names = new Set();
  walk(root, (node, parent) => {
    if (node.type !== 'Identifier' || !parent) return;
    if (parent.type === 'MemberExpression' && !parent.computed && parent.property === node) return;
    if (parent.type === 'Property' && !parent.computed && parent.key === node) return;
    if (parent.type === 'VariableDeclarator' && parent.id === node) return;
    if (parent.type === 'CatchClause' && parent.param === node) return;
    names.add(node.name);
  });
  return names;
}

function declaredNames(root) {
  const names = new Set();
  walk(root, (node) => {
    if (node.type === 'VariableDeclarator') boundNames(node.id, names);
  });
  return names;
}

function findRouteHandler(ast, routePath) {
  let handler = null;
  walk(ast, (node) => {
    if (handler || node.type !== 'CallExpression') return;
    const [first] = node.arguments;
    if (!first || first.type !== 'Literal' || first.value !== routePath) return;
    const last = node.arguments[node.arguments.length - 1];
    if (last && (last.type === 'ArrowFunctionExpression' || last.type === 'FunctionExpression')) {
      handler = last;
    }
  });
  return handler;
}

test('generateContent catch block only reads names declared in the handler scope', () => {
  const ast = acorn.parse(readFileSync(SERVER, 'utf8'), {
    ecmaVersion: 'latest',
    sourceType: 'module'
  });

  const handler = findRouteHandler(ast, '/api/gemini/generateContent');
  assert.ok(handler, 'the /api/gemini/generateContent handler must be found');

  const tryStatement = handler.body.body.find(node => node.type === 'TryStatement');
  assert.ok(tryStatement, 'the handler must wrap its work in a try/catch');
  assert.ok(tryStatement.handler, 'the try must have a catch clause');

  // Names the catch can legitimately see: everything declared in the handler body
  // outside the try, plus the handler's own parameters.
  const handlerScope = new Set();
  for (const param of handler.params) boundNames(param, handlerScope);
  for (const statement of handler.body.body) {
    if (statement.type === 'VariableDeclaration') {
      for (const declarator of statement.declarations) boundNames(declarator.id, handlerScope);
    }
  }

  const declaredInTry = declaredNames(tryStatement.block);
  const readInCatch = readIdentifiers(tryStatement.handler.body);

  const trapped = [...readInCatch]
    .filter(name => declaredInTry.has(name) && !handlerScope.has(name))
    .sort();

  assert.deepEqual(
    trapped,
    [],
    `catch reads ${trapped.join(', ')} but they are declared inside the try — ` +
    'hoist them to the handler scope or they throw ReferenceError on every failure path'
  );
});

// The locally-invalid-report path (parseAndValidateAnalysisReport failing on a
// successful provider response) returns early — its catch sibling never runs,
// so the quota refund must be invoked inline. This pins issue #112: without
// the call, every LENGTH-truncated JSON response permanently burned a tiered
// request + token estimate with no analysis delivered.
test('generateContent refunds the quota on the invalid-report early return', () => {
  const ast = acorn.parse(readFileSync(SERVER, 'utf8'), {
    ecmaVersion: 'latest',
    sourceType: 'module'
  });

  const handler = findRouteHandler(ast, '/api/gemini/generateContent');
  assert.ok(handler, 'the /api/gemini/generateContent handler must be found');

  const tryStatement = handler.body.body.find(node => node.type === 'TryStatement');
  assert.ok(tryStatement, 'the handler must wrap its work in a try/catch');

  // Find `if (!reportValidation.valid) { … }` inside the try block.
  const invalidReportIf = tryStatement.block.body.find(node =>
    node.type === 'IfStatement' &&
    node.test.type === 'UnaryExpression' &&
    node.test.operator === '!' &&
    node.test.argument.type === 'MemberExpression' &&
    node.test.argument.property?.name === 'valid' &&
    node.test.argument.object?.name === 'reportValidation'
  );
  assert.ok(invalidReportIf, 'the invalid-report early return must be recognizable');

  const callsRefund = (node) => {
    if (!node || typeof node.type !== 'string') return false;
    if (node.type === 'CallExpression' && node.callee?.name === 'refundReservation') return true;
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'loc' || key === 'range') continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child.type === 'string' && callsRefund(child)) return true;
        }
      } else if (value && typeof value.type === 'string' && callsRefund(value)) {
        return true;
      }
    }
    return false;
  };

  assert.ok(
    invalidReportIf.consequent && callsRefund(invalidReportIf.consequent),
    'the invalid-report path must call refundReservation before returning the 502'
  );

  // And the refund must actually be reachable: the block must return only
  // after the refund call, not before.
  const statements = invalidReportIf.consequent.body ?? [invalidReportIf.consequent];
  const returnIndex = statements.findIndex(s => s.type === 'ReturnStatement');
  const refundIndex = statements.findIndex(s => callsRefund(s));
  assert.ok(refundIndex >= 0 && (returnIndex === -1 || refundIndex < returnIndex),
    'refundReservation must run before the early return');

  walk(handler.body, (node, parent) => {
    if (node.type === 'CallExpression' && node.callee?.name === 'refundReservation') {
      assert.equal(parent?.type, 'AwaitExpression',
        'finish asynchronous refunds before sending the failure response');
    }
  });
});

// Which backend admitted each scope (shared store or this instance) is the
// ledger's job (tests/sharedCounters.test.mjs); the handler must hand it the
// reservation it got back and wait for the refund before answering.
test('generateContent refunds through the quota ledger and waits for shared accounting', async () => {
  const source = readFileSync(SERVER, 'utf8');
  const handler = findRouteHandler(acorn.parse(source, {
    ecmaVersion: 'latest', sourceType: 'module'
  }), '/api/gemini/generateContent');
  const declaration = handler.body.body
    .flatMap(statement => statement.type === 'VariableDeclaration' ? statement.declarations : [])
    .find(node => node.id.name === 'refundReservation');
  assert.ok(declaration, 'the shared failure cleanup must be found');
  const makeRefund = new Function('quotaReservation', 'quotaLedger', `
    const quotaKey = 'session-a';
    const estimatedInputTokens = 10;
    const quotaRefundCap = 3;
    const quotaWindowSeconds = 3600;
    const shouldRefund = () => true;
    const log = { warn() {} };
    const safeToken = value => value;
    const classifyQuotaFailure = () => 'upstream';
    return (${source.slice(declaration.init.start, declaration.init.end)});
  `);
  const calls = [];
  let finishRefund;
  const ledger = {
    refund(reservation, args) {
      calls.push([reservation, args]);
      return new Promise(resolve => { finishRefund = resolve; });
    }
  };
  const error = new Error('invalid upstream report');
  const reservation = { allowed: true, entries: [{ key: 'session-a', shared: true }] };
  let completed = false;
  const pending = makeRefund(reservation, ledger)(error).then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false, 'shared refunds must finish before cleanup resolves');
  assert.deepEqual(calls, [[reservation, {
    requestCost: 1, tokenCost: 10, refundCap: 3, windowSeconds: 3600
  }]]);
  finishRefund({ refunded: true });
  await pending;

  calls.length = 0;
  await makeRefund(undefined, ledger)(error);
  await makeRefund({ allowed: false }, ledger)(error);
  assert.deepEqual(calls, [], 'failures without an admitted reservation must not decrement quotas');
});
