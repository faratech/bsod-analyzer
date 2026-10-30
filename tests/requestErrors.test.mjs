import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRequestError } from '../server/requestErrors.js';

// Issue #333: malformed multipart bodies answered 500 INTERNAL_ERROR and a
// non-multipart body to /api/analyze 406 INTERNAL_ERROR, each logged as a
// server error. These are client errors with their own codes.
const fastifyError = (code, message, statusCode) => Object.assign(new Error(message), { code, statusCode });
const opts = { maxFileSizeMb: 128 };

test('malformed multipart bodies are a 400 INVALID_MULTIPART client error (issue #333)', () => {
  for (const error of [
    new Error('Multipart: Boundary not found'),
    new Error('Unexpected end of form'),
    new Error('Unexpected end of multipart data'),
    new Error('Part terminated early due to unexpected end of multipart data'),
    new Error('Malformed part header'),
    new TypeError('Boundary required'),
    fastifyError('FST_MP_PREMATURE_CLOSE', 'the request was closed before the multipart data was fully parsed', 400),
    fastifyError('FST_PROTO_VIOLATION', 'prototype property is not allowed as field name', 400),
    fastifyError('FST_INVALID_JSON_FIELD_ERROR', 'a request field is not a valid JSON as declared by its Content-Type', 406)
  ]) {
    const result = classifyRequestError(error, opts);
    assert.equal(result.status, 400, error.message);
    assert.equal(result.code, 'INVALID_MULTIPART', error.message);
    assert.equal(result.clientError, true);
    assert.doesNotMatch(result.message, /internal/i);
  }
});

test('a body that is not multipart is a 415 UNSUPPORTED_MEDIA_TYPE (issue #333)', () => {
  for (const error of [
    fastifyError('FST_INVALID_MULTIPART_CONTENT_TYPE', 'the request is not multipart', 406),
    new Error('Unsupported Content-Type.'),
    new TypeError('Missing Content-Type-header.')
  ]) {
    const result = classifyRequestError(error, opts);
    assert.equal(result.status, 415, error.message);
    assert.equal(result.code, 'UNSUPPORTED_MEDIA_TYPE', error.message);
    assert.equal(result.clientError, true);
    assert.match(result.message, /multipart\/form-data/);
  }
});

test('existing mappings are kept and unknown failures stay a 500 server error', () => {
  assert.deepEqual(
    classifyRequestError(fastifyError('FST_REQ_FILE_TOO_LARGE', 'request file too large', 413), opts),
    { status: 413, code: 'FST_REQ_FILE_TOO_LARGE', message: 'File is too large. Maximum size is 128MB', clientError: true }
  );
  assert.equal(classifyRequestError(fastifyError('FST_FILES_LIMIT', 'reach files limit', 413), opts).code, 'FST_FILES_LIMIT');
  assert.equal(classifyRequestError(Object.assign(new Error('x'), { code: 'LIMIT_UNEXPECTED_FILE', status: 400 }), opts).status, 400);
  assert.equal(classifyRequestError(Object.assign(new Error('too big'), { type: 'entity.too.large', status: 413 }), opts).code, 'REQUEST_TOO_LARGE');
  assert.equal(classifyRequestError(new SyntaxError('Unexpected end of JSON input'), opts).code, 'INVALID_JSON');
  assert.equal(classifyRequestError(new Error('Invalid file type. Allowed: .dmp'), opts).code, 'INVALID_FILE_TYPE');
  assert.equal(classifyRequestError(new Error('Runtime store unavailable'), opts).status, 503);

  const unknown = classifyRequestError(new Error('boom'), opts);
  assert.deepEqual(unknown, { status: 500, code: 'INTERNAL_ERROR', message: 'An internal server error occurred', clientError: false });
  const teapot = classifyRequestError(Object.assign(new Error('nope'), { status: 418 }), opts);
  assert.equal(teapot.status, 418);
  assert.equal(teapot.message, 'nope');
  assert.equal(teapot.clientError, true);
});
