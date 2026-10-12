import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

// server.js has no unit tests; like tests/aiHandlerScope.test.mjs this pins
// wiring that only fails when the failure path actually runs. The dev branch
// of requireSession must seed a session id: downstream handlers key file
// ownership, quota session scope and signed handles off req.sessionId, so an
// unset id silently no-ops them and shares the "undefined" handle tag across
// dev users (issue #175).
const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));
const ast = acorn.parse(readFileSync(SERVER, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'range') continue;
    const value = node[key];
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value.type === 'string') walk(value, visit);
  }
}

test('requireSession development branch seeds req.sessionId and req.sessionData', () => {
  let devBranch = null;
  walk(ast, node => {
    if (node.type !== 'IfStatement') return;
    let isDevCheck = false;
    walk(node.test, inner => {
      if (inner.type === 'Literal' && inner.value === 'development') isDevCheck = true;
    });
    if (isDevCheck && !devBranch) devBranch = node;
  });
  assert.ok(devBranch, 'development branch of requireSession not found');
  const assigned = new Set();
  walk(devBranch.consequent, node => {
    if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression'
        && node.left.object.name === 'req') {
      assigned.add(node.left.property.name);
    }
  });
  assert.ok(assigned.has('sessionId'), 'dev branch must set req.sessionId');
  assert.ok(assigned.has('sessionData'), 'dev branch must set req.sessionData');
});
