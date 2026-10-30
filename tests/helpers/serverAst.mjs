// Shared AST helpers for tests that pin server.js wiring. server.js has no
// unit tests (it starts the server on import), so route chains and call
// sites are read from its syntax tree instead. Not a test file itself: the
// runner only picks up tests/*.test.mjs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const SERVER = fileURLToPath(new URL('../../server.js', import.meta.url));
export const serverSource = readFileSync(SERVER, 'utf8');
export const serverAst = acorn.parse(serverSource, { ecmaVersion: 'latest', sourceType: 'module' });

export const text = node => serverSource.slice(node.start, node.end);

export function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'range') continue;
    const value = node[key];
    if (Array.isArray(value)) value.forEach(child => walk(child, visit, node));
    else if (value && typeof value.type === 'string') walk(value, visit, node);
  }
}

export function find(root, predicate) {
  const found = [];
  walk(root, (node, parent) => { if (predicate(node, parent)) found.push({ node, parent }); });
  return found;
}

export function topLevelInit(name) {
  for (const statement of serverAst.body) {
    if (statement.type !== 'VariableDeclaration') continue;
    const declarator = statement.declarations.find(node => node.id.name === name);
    if (declarator) return declarator.init;
  }
  return null;
}

// Top-level `app.<method>(path, ...middleware, handler)` registrations.
export function routes(method) {
  const found = [];
  for (const statement of serverAst.body) {
    const call = statement.expression;
    if (call?.type !== 'CallExpression' || call.callee.property?.name !== method) continue;
    if (typeof call.arguments[0]?.value !== 'string') continue;
    found.push({ path: call.arguments[0].value, call });
  }
  return found;
}

// Middleware names of a route: identifiers by name, calls by callee name
// (`upload.single('file')` -> 'single', `rejectLargeBody(n)` -> 'rejectLargeBody').
export function middlewareNames(call) {
  return call.arguments.slice(1, -1).map(arg => arg.type === 'Identifier' ? arg.name : arg.callee?.name || arg.callee?.property?.name);
}

export function routeMiddleware(method, path) {
  const route = routes(method).find(entry => entry.path === path);
  return route ? middlewareNames(route.call) : null;
}
