import test from 'node:test';
import assert from 'node:assert/strict';
import { DATA_USE_TERMS_HEADER, DATA_USE_TERMS_VERSION, acceptsCurrentDataUseTerms } from '../shared/dataUseTerms.js';
import { DATA_USE_TERMS_REQUIRED, requireDataUseTerms } from '../server/dataUseTerms.js';
import { middlewareNames, routeMiddleware, routes } from './helpers/serverAst.mjs';

function run(headers) {
  let nextCalled = false;
  const res = {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  requireDataUseTerms({ headers }, res, () => { nextCalled = true; });
  return { nextCalled, res };
}

test('current terms version passes through', () => {
  const { nextCalled, res } = run({ [DATA_USE_TERMS_HEADER.toLowerCase()]: DATA_USE_TERMS_VERSION });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
});

test('missing or outdated terms are rejected with 428 and a friendly code', () => {
  for (const headers of [{}, { [DATA_USE_TERMS_HEADER.toLowerCase()]: '2020-01' }, { [DATA_USE_TERMS_HEADER.toLowerCase()]: '' }]) {
    const { nextCalled, res } = run(headers);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 428);
    assert.equal(res.body.code, DATA_USE_TERMS_REQUIRED);
    assert.match(res.body.error, /analyzer page/);
  }
});

test('acceptsCurrentDataUseTerms trims and compares exactly', () => {
  assert.equal(acceptsCurrentDataUseTerms(` ${DATA_USE_TERMS_VERSION} `), true);
  assert.equal(acceptsCurrentDataUseTerms(undefined), false);
});

// Route wiring (issue #263): the middleware above only matters if the
// dump-submitting routes run it, after authentication and the cost-bearing
// limiters and before any body is parsed or buffered.
const BODY_PARSERS = new Set(['defaultJsonParser', 'single', 'array', 'fields', 'any']);
const DUMP_ROUTES = [
  ['/api/gemini/generateContent', ['geminiLimiter', 'geminiConcurrency'], 'defaultJsonParser'],
  ['/api/windbg/upload', ['windbgUploadLimiter', 'windbgUploadSessionLimiter', 'windbgUploadConcurrency'], 'single'],
  ['/api/extract-archive', ['archiveLimiter', 'archiveSessionLimiter', 'archiveConcurrency'], 'single']
];

test('dump-submitting routes run requireDataUseTerms after the session and limiters, before the body parser', () => {
  for (const [path, limiters, parser] of DUMP_ROUTES) {
    const chain = routeMiddleware('post', path);
    assert.ok(chain, `${path} must be registered`);
    const termsAt = chain.indexOf('requireDataUseTerms');
    assert.ok(termsAt >= 0, `${path} must run requireDataUseTerms: ${chain}`);
    assert.equal(chain.lastIndexOf('requireDataUseTerms'), termsAt, `${path} runs requireDataUseTerms once`);
    const sessionAt = chain.indexOf('requireSession');
    assert.ok(sessionAt >= 0 && sessionAt < termsAt, `${path} must run requireSession before requireDataUseTerms: ${chain}`);
    for (const limiter of limiters) {
      const at = chain.indexOf(limiter);
      assert.ok(at >= 0 && at < termsAt, `${path} must run ${limiter} before requireDataUseTerms: ${chain}`);
    }
    const parserAt = chain.indexOf(parser);
    assert.ok(parserAt > termsAt, `${path} must parse the body (${parser}) only after requireDataUseTerms: ${chain}`);
    assert.ok(chain.slice(0, termsAt).every(name => !BODY_PARSERS.has(name)), `${path} parses no body before requireDataUseTerms: ${chain}`);
  }
});

test('every session-gated route that accepts a multipart upload requires the data-use terms', () => {
  // /api/analyze is the API-key external API (no browser, no consent checkbox).
  const uploads = [];
  for (const method of ['post', 'put', 'patch']) {
    for (const { path, call } of routes(method)) {
      const chain = middlewareNames(call);
      const uploadAt = call.arguments.slice(1, -1).findIndex(arg => arg.type === 'CallExpression'
        && arg.callee.object?.name === 'upload');
      if (uploadAt < 0 || !chain.includes('requireSession')) continue;
      uploads.push(path);
      const termsAt = chain.indexOf('requireDataUseTerms');
      assert.ok(termsAt >= 0 && termsAt < uploadAt, `${path} must run requireDataUseTerms before ${chain[uploadAt]}: ${chain}`);
    }
  }
  assert.deepEqual(uploads.sort(), ['/api/extract-archive', '/api/windbg/upload']);
});
