import test from 'node:test';
import assert from 'node:assert/strict';
import { DATA_USE_TERMS_HEADER, DATA_USE_TERMS_VERSION, acceptsCurrentDataUseTerms } from '../shared/dataUseTerms.js';
import { DATA_USE_TERMS_REQUIRED, requireDataUseTerms } from '../server/dataUseTerms.js';

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
