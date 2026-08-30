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
