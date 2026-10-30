// HTTP answer for an error that reached the request error middleware
// (server.js): parser, upload and rate-limit store failures. clientError
// marks a 4xx, which the middleware logs as a warning, not request.error.

// A multipart body the parser cannot read (@fastify/multipart, busboy and its
// dicer part parser): no boundary, a truncated body, a broken part header.
const INVALID_MULTIPART_CODES = new Set(['FST_MP_PREMATURE_CLOSE', 'FST_PROTO_VIOLATION', 'FST_INVALID_JSON_FIELD_ERROR']);
const INVALID_MULTIPART_MESSAGE = /^Multipart: Boundary not found$|^Boundary required$|^Unexpected end of (form|multipart data)$|terminated early due to unexpected end of multipart data$|^Malformed part header$/;
// A body that is not multipart at all on a multipart route.
const NOT_MULTIPART_MESSAGE = /^Unsupported Content-Type\.$|^Missing Content-Type-header\.$/;

export function classifyRequestError(error, { maxFileSizeMb }) {
  let status = error?.status || error?.statusCode || 500;
  let code = 'INTERNAL_ERROR';
  let message = 'An internal server error occurred';
  const text = String(error?.message || '');

  if (error?.code === 'FST_REQ_FILE_TOO_LARGE' || error?.code === 'LIMIT_FILE_SIZE') {
    status = 413;
    code = error.code;
    message = `File is too large. Maximum size is ${maxFileSizeMb}MB`;
  } else if (['FST_FILES_LIMIT', 'FST_FIELDS_LIMIT', 'FST_PARTS_LIMIT'].includes(error?.code)) {
    status = 413;
    code = error.code;
    message = 'Multipart upload contains too many parts';
  } else if (INVALID_MULTIPART_CODES.has(error?.code) || INVALID_MULTIPART_MESSAGE.test(text)) {
    status = 400;
    code = 'INVALID_MULTIPART';
    message = 'The request body is not a valid multipart/form-data upload';
  } else if (error?.code === 'FST_INVALID_MULTIPART_CONTENT_TYPE' || NOT_MULTIPART_MESSAGE.test(text)) {
    status = 415;
    code = 'UNSUPPORTED_MEDIA_TYPE';
    message = 'Send the file as multipart/form-data';
  } else if (error?.code === 'LIMIT_UNEXPECTED_FILE') {
    status = 400;
    code = error.code;
    message = text;
  } else if (error?.type === 'entity.too.large') {
    status = 413;
    code = 'REQUEST_TOO_LARGE';
    message = 'Request body is too large';
  } else if (error?.type === 'entity.parse.failed' || error instanceof SyntaxError) {
    status = 400;
    code = 'INVALID_JSON';
    message = 'Request body is not valid JSON';
  } else if (/Invalid file type/i.test(text)) {
    status = 400;
    code = 'INVALID_FILE_TYPE';
    message = text;
  } else if (/Runtime store unavailable|Runtime store required/i.test(text)) {
    status = 503;
    code = 'RUNTIME_STORE_UNAVAILABLE';
    message = 'Service state store is temporarily unavailable';
  } else if (status < 500) {
    message = text || message;
  }
  return { status, code, message, clientError: status < 500 };
}
