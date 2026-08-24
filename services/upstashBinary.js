/**
 * Minimal binary transport for large Upstash Redis string values.
 *
 * `@upstash/redis` serializes command arguments through JSON, which expands a
 * Buffer into a JSON object. Upstash's REST API also supports binary SET bodies
 * and RESP2 responses, allowing analysis-cache values to stay compressed both
 * in transit and at rest.
 */

const RESP_BULK_PREFIX = 0x24; // $
const RESP_ERROR_PREFIX = 0x2d; // -
const CR = 0x0d;
const LF = 0x0a;

export class UpstashBinaryError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'UpstashBinaryError';
  }
}

function findCrlf(buffer, start = 0) {
  for (let index = start; index < buffer.length - 1; index += 1) {
    if (buffer[index] === CR && buffer[index + 1] === LF) return index;
  }
  return -1;
}

/**
 * Parse one RESP2 bulk-string response without interpreting the payload as
 * UTF-8. GET returns either a bulk string or a null bulk string.
 */
export function parseResp2BulkString(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buffer.length < 5) {
    throw new UpstashBinaryError('Truncated RESP2 response');
  }

  const lineEnd = findCrlf(buffer, 1);
  if (lineEnd === -1) {
    throw new UpstashBinaryError('RESP2 response is missing a line terminator');
  }

  if (buffer[0] === RESP_ERROR_PREFIX) {
    const message = buffer.subarray(1, lineEnd).toString('utf8');
    throw new UpstashBinaryError(`Upstash command failed: ${message}`);
  }
  if (buffer[0] !== RESP_BULK_PREFIX) {
    throw new UpstashBinaryError('Expected a RESP2 bulk-string response');
  }

  const lengthText = buffer.subarray(1, lineEnd).toString('ascii');
  if (!/^-?\d+$/.test(lengthText)) {
    throw new UpstashBinaryError('RESP2 bulk-string length is invalid');
  }
  const payloadLength = Number(lengthText);
  if (payloadLength === -1) {
    if (buffer.length !== lineEnd + 2) {
      throw new UpstashBinaryError('Malformed RESP2 null bulk string');
    }
    return null;
  }
  if (!Number.isSafeInteger(payloadLength) || payloadLength < 0) {
    throw new UpstashBinaryError('RESP2 bulk-string length is out of range');
  }

  const payloadStart = lineEnd + 2;
  const payloadEnd = payloadStart + payloadLength;
  if (
    payloadEnd + 2 !== buffer.length ||
    buffer[payloadEnd] !== CR ||
    buffer[payloadEnd + 1] !== LF
  ) {
    throw new UpstashBinaryError('RESP2 bulk-string payload length does not match the response');
  }
  return buffer.subarray(payloadStart, payloadEnd);
}

function normalizeBaseUrl(url) {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) {
    throw new TypeError('A valid HTTPS Upstash REST URL is required');
  }
  return url.replace(/\/+$/, '');
}

function commandUrl(baseUrl, command, key, options = {}) {
  const url = new URL(`${baseUrl}/${command}/${encodeURIComponent(key)}`);
  for (const [name, value] of Object.entries(options)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(name, String(value));
    }
  }
  return url;
}

async function readHttpError(response) {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text);
    return parsed?.error || `HTTP ${response.status}`;
  } catch {
    return text.slice(0, 300) || `HTTP ${response.status}`;
  }
}

// Transient transport failures worth another attempt. RESP2-level command
// errors (parsed after a 200) stay fail-fast because they are permanent.
function isRetryableHttpStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function createHttpTransportError(response) {
  const error = new UpstashBinaryError(await readHttpError(response));
  error.status = response.status;
  const retryAfterSeconds = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    error.retryAfterMs = Math.min(retryAfterSeconds * 1000, 5000);
  }
  return error;
}

export function createUpstashBinaryClient({
  url,
  token,
  fetchImpl = globalThis.fetch,
  retries = 5,
  backoff = attempt => Math.exp(attempt) * 50,
  delayImpl = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const baseUrl = normalizeBaseUrl(url);
  if (typeof token !== 'string' || token.length === 0) {
    throw new TypeError('An Upstash REST token is required');
  }
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('A fetch implementation is required');
  }
  if (!Number.isInteger(retries) || retries < 0) {
    throw new TypeError('retries must be a non-negative integer');
  }

  let syncToken = '';
  let requestSequence = 0;
  let tokenSequence = 0;

  async function request(requestUrl, init) {
    const sequence = ++requestSequence;
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${token}`);
      if (syncToken) headers.set('Upstash-Sync-Token', syncToken);

      try {
        const response = await fetchImpl(requestUrl, { ...init, headers });
        if (!response.ok) {
          throw await createHttpTransportError(response);
        }
        const responseSyncToken = response.headers.get('upstash-sync-token') || '';
        if (sequence >= tokenSequence) {
          syncToken = responseSyncToken;
          tokenSequence = sequence;
        }
        return response;
      } catch (error) {
        const retryableTransportStatus =
          error instanceof UpstashBinaryError &&
          typeof error.status === 'number' &&
          isRetryableHttpStatus(error.status);
        if ((error instanceof UpstashBinaryError && !retryableTransportStatus) || attempt === retries) {
          throw error;
        }
        lastError = error;
        await delayImpl(error.retryAfterMs ?? backoff(attempt));
      }
    }
    throw lastError || new UpstashBinaryError('Upstash request failed');
  }

  return {
    async get(key) {
      const response = await request(commandUrl(baseUrl, 'get', key), {
        method: 'GET',
        headers: {
          'Upstash-Response-Format': 'resp2',
        },
      });
      return parseResp2BulkString(Buffer.from(await response.arrayBuffer()));
    },

    async set(key, value, { ex } = {}) {
      const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (ex !== undefined && (!Number.isInteger(ex) || ex <= 0)) {
        throw new TypeError('ex must be a positive integer when provided');
      }
      const response = await request(commandUrl(baseUrl, 'set', key, { EX: ex }), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
        },
        body: buffer,
      });
      const result = await response.json();
      if (result?.error) throw new UpstashBinaryError(result.error);
      if (result?.result !== 'OK') {
        throw new UpstashBinaryError('Unexpected response to binary SET');
      }
      return true;
    },

    async setNx(key, value) {
      const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const response = await request(commandUrl(baseUrl, 'setnx', key), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
        },
        body: buffer,
      });
      const result = await response.json();
      if (result?.error) throw new UpstashBinaryError(result.error);
      if (result?.result !== 0 && result?.result !== 1) {
        throw new UpstashBinaryError('Unexpected response to binary SETNX');
      }
      return result.result === 1;
    },

    async del(key) {
      const response = await request(commandUrl(baseUrl, 'del', key), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
        },
      });
      const result = await response.json();
      if (result?.error) throw new UpstashBinaryError(result.error);
      if (!Number.isInteger(result?.result) || result.result < 0) {
        throw new UpstashBinaryError('Unexpected response to binary DEL');
      }
      return result.result > 0;
    },

    getSyncToken() {
      return syncToken;
    },
  };
}
