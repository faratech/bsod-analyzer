// server.js wiring for the submit-side protections whose logic is unit-tested
// elsewhere (issue #355): nothing else fails if a route stops using them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { find, routeMiddleware, routes, text, topLevelInit } from './helpers/serverAst.mjs';

// #338: the per-instance submit cap refuses before the limiters spend a slot
// and before upload.single reads (up to 100 MB of) the body.
test('the upload route runs the cap gate after the session and before the limiters and the body parser (#338, #355)', () => {
  const chain = routeMiddleware('post', '/api/windbg/upload');
  assert.ok(chain, '/api/windbg/upload must be registered');
  const gateAt = chain.indexOf('windbgUploadCapGate');
  assert.ok(gateAt >= 0, `the upload route must run windbgUploadCapGate: ${chain}`);
  assert.equal(chain.lastIndexOf('windbgUploadCapGate'), gateAt, 'the gate runs once');
  const sessionAt = chain.indexOf('requireSession');
  assert.ok(sessionAt >= 0 && sessionAt < gateAt, `requireSession must run before the cap gate: ${chain}`);
  for (const later of ['windbgUploadLimiter', 'windbgUploadSessionLimiter', 'windbgUploadConcurrency', 'single']) {
    const at = chain.indexOf(later);
    assert.ok(at > gateAt, `${later} must run after the cap gate: ${chain}`);
  }

  const gate = topLevelInit('windbgUploadCapGate');
  assert.equal(gate?.callee?.name, 'createWinDbgUploadCapGate');
  const submitter = gate.arguments[0].properties.find(p => p.key.name === 'submitter');
  assert.equal(submitter && text(submitter.value), 'windbgUploadSubmitter', 'the gate counts the upload route\'s own submitter');
});

// #336: an unconfirmed outcome has no result; it must answer the 409 hold
// before anything reads submitted.result (that threw: a retryable 500).
test('/api/analyze answers an unconfirmed submit with the held 409 before reading the result (#336, #355)', () => {
  const route = routes('post').find(entry => entry.path === '/api/analyze');
  assert.ok(route, '/api/analyze must be registered');
  const handler = route.call.arguments.at(-1);
  const outcomeBranch = outcome => find(handler, node => node.type === 'IfStatement'
    && /^submitted\.outcome === '([a-z]+)'$/.test(text(node.test)) && text(node.test).endsWith(`'${outcome}'`))
    .map(({ node }) => node);

  const [unconfirmed, ...extra] = outcomeBranch('unconfirmed');
  assert.ok(unconfirmed, 'the handler must branch on submitted.outcome === \'unconfirmed\'');
  assert.equal(extra.length, 0);
  const [timeout] = outcomeBranch('timeout');
  assert.ok(timeout && unconfirmed.start < timeout.start, 'unconfirmed is handled before timeout');
  const resultReads = find(handler, node => node.type === 'MemberExpression' && text(node) === 'submitted.result').map(({ node }) => node.start);
  assert.ok(resultReads.length > 0);
  assert.ok(resultReads.every(at => at > unconfirmed.end), 'submitted.result is only read after the unconfirmed branch');

  const held = find(unconfirmed.consequent, node => node.type === 'VariableDeclarator'
    && node.init?.type === 'CallExpression' && node.init.callee.name === 'analyzeHeldSubmissionResponse')[0];
  assert.ok(held, 'the branch builds its answer with analyzeHeldSubmissionResponse');
  const name = held.node.id.name;
  const body = text(unconfirmed.consequent);
  assert.ok(body.includes(`res.set(${name}.headers)`), body);
  assert.ok(body.includes(`return res.status(${name}.status).json(${name}.body)`), body);
});
