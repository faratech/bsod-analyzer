import zlib from 'node:zlib';

const PREFERRED_ENCODINGS = ['zstd', 'br', 'gzip', 'deflate'];
const DEFAULT_THRESHOLD_BYTES = 1024;
const NO_BODY_STATUS_CODES = new Set([101, 204, 304]);
const COMPRESSIBLE_APPLICATION_TYPES = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/json',
  'application/ld+json',
  'application/manifest+json',
  'application/rss+xml',
  'application/xhtml+xml',
  'application/xml'
]);

function supportsEncoding(encoding) {
  if (encoding === 'zstd') return typeof zlib.zstdCompressSync === 'function';
  if (encoding === 'br') return typeof zlib.brotliCompressSync === 'function';
  if (encoding === 'gzip') return typeof zlib.gzipSync === 'function';
  if (encoding === 'deflate') return typeof zlib.deflateSync === 'function';
  return false;
}

function parseAcceptEncoding(value) {
  return String(value || '')
    .split(',')
    .map(part => {
      const [token, ...params] = part.trim().split(';');
      const encoding = token.trim().toLowerCase();
      if (!encoding) return null;
      const qParam = params.find(param => param.trim().toLowerCase().startsWith('q='));
      const q = qParam ? Number.parseFloat(qParam.split('=')[1]) : 1;
      return {
        encoding,
        q: Number.isFinite(q) ? q : 0
      };
    })
    .filter(Boolean);
}

export function negotiateEncoding(acceptEncoding) {
  const accepted = parseAcceptEncoding(acceptEncoding);
  if (accepted.length === 0) return null;

  let wildcardQ = null;
  const byEncoding = new Map();
  for (const item of accepted) {
    if (item.encoding === '*') {
      wildcardQ = item.q;
    } else {
      byEncoding.set(item.encoding, item.q);
    }
  }

  const candidates = PREFERRED_ENCODINGS
    .map((encoding, preference) => ({
      encoding,
      preference,
      q: byEncoding.has(encoding) ? byEncoding.get(encoding) : wildcardQ
    }))
    .filter(candidate => (candidate.q ?? 0) > 0 && supportsEncoding(candidate.encoding))
    .sort((a, b) => b.q - a.q || a.preference - b.preference);

  return candidates[0]?.encoding || null;
}

function normalizeHeaderValue(value) {
  if (Array.isArray(value)) return value.join(', ');
  return value === undefined || value === null ? '' : String(value);
}

function getHeader(res, name) {
  return normalizeHeaderValue(res.getHeader?.(name));
}

function appendVaryAcceptEncoding(res) {
  const current = getHeader(res, 'Vary');
  const values = current
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (!values.some(value => value.toLowerCase() === 'accept-encoding')) {
    values.push('Accept-Encoding');
  }
  res.setHeader('Vary', values.join(', '));
}

export function isCompressibleContentType(contentType) {
  const normalized = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith('text/')) return true;
  if (normalized === 'image/svg+xml') return true;
  if (COMPRESSIBLE_APPLICATION_TYPES.has(normalized)) return true;
  return /\+(json|xml)$/.test(normalized);
}

function toBuffer(payload) {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof Uint8Array) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (typeof payload === 'string') return Buffer.from(payload);
  return null;
}

export function compressBuffer(buffer, encoding) {
  if (encoding === 'zstd') return zlib.zstdCompressSync(buffer);
  if (encoding === 'br') return zlib.brotliCompressSync(buffer);
  if (encoding === 'gzip') return zlib.gzipSync(buffer);
  if (encoding === 'deflate') return zlib.deflateSync(buffer);
  return buffer;
}

function resolveForcedEncoding(forceEncoding, req, res, payload) {
  const value = typeof forceEncoding === 'function'
    ? forceEncoding(req, res, payload)
    : forceEncoding;
  const encoding = typeof value === 'string' ? value.toLowerCase() : null;
  return encoding && supportsEncoding(encoding) ? encoding : null;
}

export function maybeCompressPayload({ req, res, payload, options = {} }) {
  if (options.enabled === false || res.headersSent) return payload;
  if (String(req?.method || '').toUpperCase() === 'HEAD') return payload;
  if (NO_BODY_STATUS_CODES.has(res.statusCode)) return payload;
  if (getHeader(res, 'Content-Encoding')) return payload;
  if (/no-transform/i.test(getHeader(res, 'Cache-Control'))) return payload;
  if (!isCompressibleContentType(getHeader(res, 'Content-Type'))) return payload;

  const buffer = toBuffer(payload);
  const forcedEncoding = resolveForcedEncoding(options.forceEncoding, req, res, payload);
  const threshold = forcedEncoding
    ? (Number.isFinite(options.forceThreshold) ? options.forceThreshold : 0)
    : (Number.isFinite(options.threshold) ? options.threshold : DEFAULT_THRESHOLD_BYTES);
  if (!buffer || buffer.length < threshold) return payload;

  const encoding = forcedEncoding || negotiateEncoding(req?.headers?.['accept-encoding']);
  if (!encoding) return payload;

  const compressed = compressBuffer(buffer, encoding);
  res.setHeader('Content-Encoding', encoding);
  res.setHeader('Content-Length', String(compressed.length));
  appendVaryAcceptEncoding(res);
  return compressed;
}
