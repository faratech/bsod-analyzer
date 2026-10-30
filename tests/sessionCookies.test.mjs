import test from 'node:test';
import assert from 'node:assert/strict';

import { ALL_SESSION_COOKIES, presentedSessionCookies } from '../server/sessionCookies.js';
import { find, routes, serverAst, text, topLevelInit, walk } from './helpers/serverAst.mjs';

const names = cookies => cookies.map(c => c.name);

test('a request that presented no session cookie clears nothing (issue #141)', () => {
  // A cross-site form POST arrives without any SameSite=Lax cookie.
  assert.deepEqual(presentedSessionCookies({}), []);
  assert.deepEqual(presentedSessionCookies({ unrelated: '1' }), []);
  assert.deepEqual(presentedSessionCookies(undefined), []);
  assert.deepEqual(presentedSessionCookies(null), []);
});

test('only the session cookies the request sent are cleared, with their attributes', () => {
  const cleared = presentedSessionCookies({ bsod_turnstile_verified: 'true', bsod_session_id: 'old', other: 'x' });
  assert.deepEqual(names(cleared), ['bsod_session_id', 'bsod_turnstile_verified']);
  assert.equal(cleared.find(c => c.name === 'bsod_session_id').httpOnly, true);
  assert.equal(cleared.find(c => c.name === 'bsod_turnstile_verified').httpOnly, false);
  // An empty value still counts as presented.
  assert.deepEqual(names(presentedSessionCookies({ bsod_session: '' })), ['bsod_session']);
});

test('the default set still covers every session cookie', () => {
  assert.deepEqual(names(ALL_SESSION_COOKIES), [
    'bsod_session', 'bsod_session_id', 'bsod_session_hash', 'bsod_turnstile_verified',
  ]);
});

// server.js call sites (issue #265): the helper above only matters if the
// session code uses it. A request that presented no bsod_session token must
// clear only the session cookies it sent; the default (clear everything) is
// right only after a presented token failed validation.
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function enclosingFunction(target) {
  let best = null;
  walk(serverAst, node => {
    if (FUNCTION_TYPES.has(node.type) && node.start <= target.start && target.end <= node.end
      && (!best || node.start >= best.start)) best = node;
  });
  return best;
}

const isNoTokenGuard = node => node.type === 'IfStatement' && node.test.type === 'UnaryExpression'
  && node.test.operator === '!' && node.test.argument.name === 'sessionToken';
const endsInReturn = block => block.type === 'BlockStatement' && block.body.at(-1)?.type === 'ReturnStatement';

test('server.js clears only the presented cookies when no session token was sent (issue #141)', () => {
  const clears = find(serverAst, node => node.type === 'CallExpression' && node.callee.name === 'clearSessionCookies')
    .map(({ node }) => node);
  assert.ok(clears.length >= 2);

  const noTokenSites = [];
  for (const call of clears) {
    const fn = enclosingFunction(call);
    const guards = find(fn, isNoTokenGuard).map(({ node }) => node);
    const inNoTokenBranch = guards.find(guard => guard.consequent.start <= call.start && call.end <= guard.consequent.end);
    if (inNoTokenBranch) {
      assert.equal(call.arguments.length, 2, `no-token clear must pass the presented cookies: ${text(call)}`);
      assert.equal(text(call.arguments[1]), 'presentedSessionCookies(req.cookies)', text(call));
      assert.ok(endsInReturn(inNoTokenBranch.consequent), 'the no-token branch must return');
      noTokenSites.push(fn);
      continue;
    }
    // Anything else must run only after the no-token branch returned, i.e. a
    // session token was presented and failed validation.
    if (call.arguments.length === 1) {
      const priorGuard = guards.find(guard => guard.end <= call.start && endsInReturn(guard.consequent));
      assert.ok(priorGuard, `clearing every session cookie is allowed only after a token was presented: ${text(call)}`);
    } else {
      assert.equal(text(call.arguments[1]), 'presentedSessionCookies(req.cookies)', text(call));
    }
  }

  // Both entry points: the requireSession middleware and GET /api/auth/session.
  const requireSession = topLevelInit('requireSession');
  const [refreshRoute] = routes('get').filter(route => route.path === '/api/auth/session');
  assert.ok(requireSession && refreshRoute);
  assert.deepEqual(noTokenSites.map(fn => fn.start).sort((a, b) => a - b),
    [requireSession.start, refreshRoute.call.arguments.at(-1).start].sort((a, b) => a - b));
  for (const fn of noTokenSites) {
    const tokenDecl = find(fn, node => node.type === 'VariableDeclarator' && node.id.name === 'sessionToken')[0]?.node;
    assert.equal(tokenDecl && text(tokenDecl.init), 'req.cookies.bsod_session');
  }
});
