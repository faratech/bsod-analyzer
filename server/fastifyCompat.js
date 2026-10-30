import Fastify from 'fastify';
import fs from 'fs';
import path from 'path';
import { maybeCompressPayload } from './rawCompression.js';
import { requestTargetPath } from './requestPath.js';

const ASSET_EXT_RE = /\.(js|css|woff2|woff|ttf|otf|eot|png|jpg|jpeg|webp|svg|ico|json|xml|txt|webmanifest)$/i;

function pathMatches(prefix, pathname) {
  if (!prefix || prefix === '/') return true;
  return pathname === prefix || pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}

// The raw request target's path (issue #350): no WHATWG URL parsing, which
// would read "//about" as a host and resolve backslashes and dot segments into
// a path the router never sees. server/requestPath.js has the policy for
// those shapes.
function getRawPathname(request) {
  return requestTargetPath(request.url);
}

// The path Fastify routes on (issue #289): find-my-way percent-decodes the URL
// with decodeURI, which keeps reserved escapes such as %2F encoded, and it keeps
// %25 encoded so the path is never decoded twice. Path-scoped middleware and
// the error format must see that same path, or `/%61pi/...` reaches /api
// handlers while skipping app.use('/api/', ...). A malformed escape keeps the
// raw path (the router rejects those anyway).
function getPathname(request) {
  const raw = getRawPathname(request);
  if (!raw.includes('%')) return raw;
  try {
    return decodeURI(raw.replace(/%25/g, '%2525'));
  } catch {
    return raw;
  }
}

function getRemoteAddress(rawReq, request) {
  return request.ip ||
    rawReq.socket?.remoteAddress ||
    rawReq.stream?.session?.socket?.remoteAddress ||
    'unknown';
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`];
  if (Number.isFinite(options.maxAge)) parts.push(`Max-Age=${Math.floor(options.maxAge / 1000)}`);
  if (options.expires instanceof Date) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) {
    const sameSite = String(options.sameSite).toLowerCase();
    parts.push(`SameSite=${sameSite.charAt(0).toUpperCase()}${sameSite.slice(1)}`);
  }
  return parts.join('; ');
}

function appendSetCookie(res, cookieValue) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookieValue);
  } else if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookieValue]);
  } else {
    res.setHeader('Set-Cookie', [existing, cookieValue]);
  }
}

function patchResponse(res, req, options = {}) {
  if (res.__bsodCompatPatched) return res;
  Object.defineProperty(res, '__bsodCompatPatched', { value: true });

  function endPayload(payload) {
    const body = maybeCompressPayload({
      req,
      res,
      payload,
      options: options.compression
    });
    res.end(body);
  }

  res.status = function status(code) {
    res.statusCode = code;
    return res;
  };

  res.set = function set(headers, value) {
    // Support the Express (name, value) form as well as a headers object.
    if (typeof headers === 'string') {
      res.setHeader(headers, value);
      return res;
    }
    for (const [key, value] of Object.entries(headers || {})) {
      res.setHeader(key, value);
    }
    return res;
  };

  res.type = function type(value) {
    res.setHeader('Content-Type', value);
    return res;
  };

  // Express-style redirect([status], location). Callers pass a same-origin
  // path; the body stays empty so HEAD and GET answer alike.
  res.redirect = function redirect(statusOrLocation, maybeLocation) {
    const status = typeof statusOrLocation === 'number' ? statusOrLocation : 302;
    const location = typeof statusOrLocation === 'number' ? maybeLocation : statusOrLocation;
    res.statusCode = status;
    res.setHeader('Location', String(location));
    res.end();
    return res;
  };

  res.cookie = function cookie(name, value, options) {
    appendSetCookie(res, serializeCookie(name, value, options));
    return res;
  };

  res.clearCookie = function clearCookie(name, options = {}) {
    appendSetCookie(res, serializeCookie(name, '', {
      ...options,
      expires: new Date(0),
      maxAge: 0
    }));
    return res;
  };

  res.json = function json(payload) {
    if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    endPayload(JSON.stringify(payload));
    return res;
  };

  res.send = function send(payload) {
    if (payload === undefined || payload === null) {
      res.end();
      return res;
    }
    if (Buffer.isBuffer(payload) || payload instanceof Uint8Array) {
      endPayload(payload);
      return res;
    }
    if (typeof payload === 'object') {
      return res.json(payload);
    }
    if (!res.headersSent && !res.getHeader('Content-Type')) {
      res.setHeader('Content-Type', ASSET_EXT_RE.test(String(payload)) ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8');
    }
    endPayload(String(payload));
    return res;
  };

  return res;
}

function patchRequest(rawReq, request) {
  const parsedBody = request.body;
  const bodyIsStream = parsedBody && typeof parsedBody === 'object' && typeof parsedBody.pipe === 'function';
  rawReq.fastifyRequest = request;
  rawReq.params = request.params || {};
  rawReq.query = request.query || {};
  rawReq.body = bodyIsStream ? rawReq.body : (parsedBody ?? rawReq.body ?? {});
  rawReq.cookies = request.cookies || rawReq.cookies || {};
  rawReq.path = getPathname(rawReq);
  rawReq.ip = getRemoteAddress(rawReq, request);
  rawReq.originalUrl = rawReq.url;
  rawReq.get = rawReq.header = function getHeader(name) {
    return rawReq.headers[String(name).toLowerCase()];
  };
  return rawReq;
}

function isEnded(res) {
  return res.writableEnded || res.destroyed;
}

// Callbacks run once a request's whole middleware/handler chain has settled.
// Unlike res 'close', this does not fire when the client disconnects while an
// async handler is still working.
const settledCallbacks = new WeakMap();

export function onRequestSettled(req, callback) {
  const callbacks = settledCallbacks.get(req);
  if (callbacks) callbacks.push(callback);
  else settledCallbacks.set(req, [callback]);
}

function runSettledCallbacks(req) {
  const callbacks = settledCallbacks.get(req) || [];
  settledCallbacks.delete(req);
  for (const callback of callbacks) {
    try { callback(); } catch { /* a callback must not break the others */ }
  }
}

function createRunner({ middlewares, errorMiddlewares, compression }) {
  return function runLegacyStack(stack, request, reply) {
    reply.hijack();
    const req = patchRequest(request.raw, request);
    const res = patchResponse(reply.raw, req, { compression });

    const runErrorHandlers = async (err) => {
      if (isEnded(res)) return;
      let index = 0;
      const nextError = async (nextErr = err) => {
        const handler = errorMiddlewares[index++];
        if (!handler) {
          res.statusCode = nextErr?.status || nextErr?.statusCode || 500;
          res.end(process.env.NODE_ENV === 'production'
            ? 'Internal Server Error'
            : (nextErr?.stack || nextErr?.message || String(nextErr)));
          return;
        }
        await new Promise(resolve => {
          let settled = false;
          const next = (chainedErr) => {
            if (settled) return;
            settled = true;
            if (chainedErr) {
              nextError(chainedErr).then(resolve);
            } else {
              resolve();
            }
          };
          try {
            const result = handler(nextErr, req, res, next);
            Promise.resolve(result).then(() => {
              // Same contract as runAt (issue #177): a handler that settled
              // without next() resolves this step, including when it ended
              // the response itself, so the stack settles and
              // onRequestSettled callbacks run. One still writing waits for
              // the response to finish.
              if (settled) return;
              if (handler.length >= 4 && !isEnded(res)) {
                res.once('finish', resolve);
                res.once('close', resolve);
                return;
              }
              resolve();
            }, next);
          } catch (handlerErr) {
            next(handlerErr);
          }
        });
      };
      await nextError(err);
    };

    const runAt = async (index) => {
      if (isEnded(res) || index >= stack.length) return;
      const layer = stack[index];
      if (!pathMatches(layer.path, req.path)) {
        await runAt(index + 1);
        return;
      }

      await new Promise(resolve => {
        let advanced = false;
        const next = (err) => {
          if (advanced) return;
          advanced = true;
          if (err) {
            runErrorHandlers(err).then(resolve);
          } else {
            runAt(index + 1).then(resolve);
          }
        };

        try {
          const result = layer.fn(req, res, next);
          Promise.resolve(result).then(() => {
            // Once next() ran, the rest of the chain resolves this layer, so the
            // stack only settles when the downstream handler has finished.
            if (advanced) return;
            if (layer.fn.length >= 3 && !isEnded(res)) {
              res.once('finish', resolve);
              res.once('close', resolve);
              return;
            }
            resolve();
          }, next);
        } catch (err) {
          next(err);
        }
      });
    };

    return runAt(0).catch(runErrorHandlers).finally(() => runSettledCallbacks(req));
  };
}

function readRequestBody(req, limitBytes) {
  if (req.body !== undefined && req.body !== null && typeof req.body !== 'object') {
    return Promise.resolve(req.body);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limitBytes && !done) {
        done = true;
        chunks.length = 0; // release buffered bytes; stop accumulating
        const err = new Error('request entity too large');
        err.type = 'entity.too.large';
        err.status = 413;
        // Drain the remainder instead of destroying the socket so the error
        // middleware can deliver a structured 413 response.
        req.resume();
        reject(err);
        return;
      }
      if (!done) chunks.push(chunk);
    });
    req.on('end', () => { if (!done) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', err => { if (!done) reject(err); });
  });
}

function parseByteLimit(limit) {
  if (typeof limit === 'number') return limit;
  const match = String(limit || '').trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i);
  if (!match) return 1024 * 1024;
  const value = Number(match[1]);
  const unit = (match[2] || 'b').toLowerCase();
  const multiplier = unit === 'gb' ? 1024 ** 3 : unit === 'mb' ? 1024 ** 2 : unit === 'kb' ? 1024 : 1;
  return Math.floor(value * multiplier);
}

export function jsonParser(options = {}) {
  const limitBytes = parseByteLimit(options.limit);
  return async function parseJsonBody(req, _res, next) {
    try {
      const contentType = String(req.headers['content-type'] || '');
      if (!/^application\/json\b/i.test(contentType)) {
        req.body = req.body || {};
        return next();
      }
      if (Buffer.isBuffer(req.body) || req.body instanceof Uint8Array) {
        const raw = Buffer.from(req.body).toString('utf8');
        req.body = raw.trim() ? JSON.parse(raw) : {};
        return next();
      }
      if (typeof req.body === 'string') {
        req.body = req.body.trim() ? JSON.parse(req.body) : {};
        return next();
      }
      if (req.body !== undefined && req.body !== null && typeof req.body === 'object') {
        return next();
      }
      const raw = await readRequestBody(req, limitBytes);
      req.body = raw.trim() ? JSON.parse(raw) : {};
      next();
    } catch (err) {
      if (err instanceof SyntaxError) err.type = 'entity.parse.failed';
      next(err);
    }
  };
}

// Entity tags of an If-None-Match value: "*" or a list of (W/)"..." tags.
// Parsed as quoted strings so a comma inside a tag does not split it.
function parseEntityTags(value) {
  const tags = [];
  const re = /\s*(W\/)?("[^"]*")\s*(?:,|$)/gy;
  const raw = String(value);
  let match;
  while (re.lastIndex < raw.length && (match = re.exec(raw))) tags.push(match[2]);
  return tags;
}

const HTTP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const HTTP_DAY = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
const HTTP_DAY_LONG = '(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)';
const HTTP_MONTH = `(${HTTP_MONTHS.join('|')})`;
const HTTP_TIME = '(\\d{2}):(\\d{2}):(\\d{2})';
// RFC 9110 5.6.7: IMF-fixdate, then the obsolete RFC 850 and asctime forms
// (case-sensitive).
const IMF_FIXDATE = new RegExp(`^${HTTP_DAY}, (\\d{2}) ${HTTP_MONTH} (\\d{4}) ${HTTP_TIME} GMT$`);
const RFC850_DATE = new RegExp(`^${HTTP_DAY_LONG}, (\\d{2})-${HTTP_MONTH}-(\\d{2}) ${HTTP_TIME} GMT$`);
const ASCTIME_DATE = new RegExp(`^${HTTP_DAY} ${HTTP_MONTH} ( \\d|\\d{2}) ${HTTP_TIME} (\\d{4})$`);

/**
 * Milliseconds since the epoch for an HTTP-date (RFC 9110 5.6.7), or null
 * when `value` is not one: only IMF-fixdate, RFC 850 and asctime are
 * accepted, with every field in range (Date.parse alone accepts "9999",
 * ISO dates and more: issue #366).
 * @param {unknown} value
 * @returns {number | null}
 */
export function parseHttpDate(value) {
  const text = String(value ?? '').trim();
  let day;
  let month;
  let year;
  let time;
  let m;
  if ((m = IMF_FIXDATE.exec(text))) {
    [, day, month, year, ...time] = m;
    year = Number(year);
  } else if ((m = RFC850_DATE.exec(text))) {
    [, day, month, year, ...time] = m;
    // A two-digit year more than 50 years in the future is the most recent
    // past year with the same last two digits.
    const now = new Date().getUTCFullYear();
    year = Math.floor(now / 100) * 100 + Number(year);
    if (year > now + 50) year -= 100;
  } else if ((m = ASCTIME_DATE.exec(text))) {
    let rest;
    [, month, day, ...rest] = m;
    time = rest.slice(0, 3);
    year = Number(rest[3]);
  } else {
    return null;
  }
  const [hour, minute, second] = time.map(Number);
  const monthIndex = HTTP_MONTHS.indexOf(month);
  const dayNumber = Number(day);
  if (hour > 23 || minute > 59 || second > 60 || dayNumber < 1) return null;
  // setUTCFullYear keeps years below 100 as written (Date.UTC maps them to
  // 19xx); a leap second (:60) counts as :59.
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, dayNumber);
  date.setUTCHours(hour, minute, Math.min(second, 59), 0);
  // Reject days past the end of the month (they would roll over).
  if (date.getUTCDate() !== dayNumber) return null;
  return date.getTime();
}

// Conditional GET/HEAD for static files (RFC 9110 13.1.2, 13.1.3, 13.2.2;
// issue #356). If-None-Match uses weak comparison (the W/ prefix is ignored on
// both sides), and when present If-Modified-Since is not consulted. Otherwise
// If-Modified-Since hits when the mtime, truncated to the whole seconds that
// Last-Modified carries, is not later than the date; invalid dates are ignored.
export function staticNotModified(headers, etag, mtimeMs) {
  const ifNoneMatch = headers?.['if-none-match'];
  if (ifNoneMatch !== undefined && String(ifNoneMatch).trim() !== '') {
    if (String(ifNoneMatch).trim() === '*') return true;
    const opaque = String(etag).replace(/^W\//, '');
    return parseEntityTags(ifNoneMatch).includes(opaque);
  }
  const ifModifiedSince = headers?.['if-modified-since'];
  if (!ifModifiedSince) return false;
  // RFC 9110 13.1.3: a value that is not a valid HTTP-date is ignored
  // (Date.parse would read "9999" as the year 9999: issue #366).
  const since = parseHttpDate(ifModifiedSince);
  if (since === null) return false;
  return Math.floor(Number(mtimeMs) / 1000) * 1000 <= since;
}

export function staticMiddleware(root, options = {}) {
  const base = path.resolve(root);
  const maxAge = options.maxAge === '1y' ? 31536000 : Number.parseInt(options.maxAge || '0', 10) || 0;
  const setHeaders = typeof options.setHeaders === 'function' ? options.setHeaders : null;
  // Extensions never served from this root (checked on the resolved file, so
  // %2F/%2E-encoded and upper-case forms are covered too).
  const skipExtensions = new Set((options.skipExtensions || []).map(ext => String(ext).toLowerCase()));

  return function serveStatic(req, res, next) {
    if (!['GET', 'HEAD'].includes(req.method)) return next();
    let pathname;
    try {
      pathname = decodeURIComponent(req.path || getPathname(req));
    } catch {
      return next();
    }
    const filePath = path.resolve(base, `.${pathname}`);
    if (!filePath.startsWith(`${base}${path.sep}`) && filePath !== base) return next();
    if (skipExtensions.has(path.extname(filePath).toLowerCase())) return next();

    fs.stat(filePath, (statErr, stat) => {
      if (statErr || !stat.isFile()) return next();
      if (setHeaders) setHeaders(res, filePath, stat);
      if (!res.getHeader('Cache-Control') && maxAge > 0) {
        res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
      }
      const etag = `W/"${stat.size.toString(16)}-${Number(stat.mtimeMs).toString(16)}"`;
      res.setHeader('Last-Modified', stat.mtime.toUTCString());
      res.setHeader('ETag', etag);
      // Byte ranges are not served (issue #356); say so instead of silently
      // answering a Range request with the whole file.
      res.setHeader('Accept-Ranges', 'none');
      if (staticNotModified(req.headers, etag, stat.mtimeMs)) {
        // Same validators and Cache-Control/Vary as the 200; no body. Static
        // files are streamed past the compression hook, so the 304 carries no
        // Content-Encoding either.
        res.statusCode = 304;
        return res.end();
      }
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(filePath);
      stream.on('error', err => {
        // Errors after the first chunk has flushed cannot turn the response
        // into an error status anymore; appending an error body would corrupt
        // the asset. Destroy the socket instead.
        if (res.headersSent) {
          res.destroy();
          return;
        }
        next(err);
      });
      stream.pipe(res);
    });
  };
}

function normalizeUseArgs(args) {
  if (typeof args[0] === 'string') {
    return { path: args[0], fns: args.slice(1).flat() };
  }
  return { path: '/', fns: args.flat() };
}

export function createFastifyCompatApp(options = {}) {
  const compression = options.compression?.enabled === false
    ? { enabled: false }
    : (options.compression || { enabled: false });
  const fastify = Fastify({
    http2: options.http2 === true,
    http2SessionTimeout: options.http2SessionTimeout,
    bodyLimit: options.bodyLimit || 1024 * 1024,
    trustProxy: options.trustProxy || false,
    logger: false,
    routerOptions: {
      ignoreTrailingSlash: true,
      // find-my-way answers 414 for longer path params (default 100).
      maxParamLength: options.maxParamLength || 100
    }
  });

  // No body is read before the Express-style stack (ingress gate, limiters,
  // requireSession) has run (issue #288). JSON is parsed per route by
  // jsonParser, multipart by @fastify/multipart's own streaming parser; every
  // other type, including Fastify's default text/plain, is handed through as
  // the unread stream instead of being buffered up to bodyLimit.
  const passthrough = function passthroughBody(_request, payload, done) {
    done(null, payload);
  };
  fastify.removeContentTypeParser('application/json');
  fastify.removeContentTypeParser('text/plain');
  fastify.addContentTypeParser(/^application\/json\b/i, passthrough);
  fastify.addContentTypeParser('*', passthrough);
  const routeBodyLimits = options.routeBodyLimits || {};

  if (compression.enabled !== false) {
    fastify.addHook('onSend', async (request, reply, payload) => {
      const res = {
        statusCode: reply.statusCode,
        headersSent: false,
        getHeader: name => reply.getHeader(name),
        setHeader: (name, value) => reply.header(name, value)
      };
      return maybeCompressPayload({
        req: request.raw,
        res,
        payload,
        options: compression
      });
    });
  }

  const middlewares = [];
  const errorMiddlewares = [];
  const runLegacyStack = createRunner({
    middlewares,
    errorMiddlewares,
    compression
  });

  fastify.setErrorHandler((error, request, reply) => {
    const status = error.statusCode || error.status || (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? 413 : 500);
    const pathname = getPathname(request.raw);
    if (pathname.startsWith('/api/')) {
      const code = status === 413
        ? 'REQUEST_TOO_LARGE'
        : error.code === 'FST_ERR_CTP_INVALID_JSON_BODY'
          ? 'INVALID_JSON'
          : 'INTERNAL_ERROR';
      const message = status === 413
        ? 'Request body is too large'
        : code === 'INVALID_JSON'
          ? 'Request body is not valid JSON'
          : 'An internal server error occurred';
      reply.code(status).send({ success: false, error: message, code });
      return;
    }
    reply.code(status).send(process.env.NODE_ENV === 'production' ? 'Internal Server Error' : error.stack || error.message);
  });

  const compat = {
    fastify,
    set(name, value) {
      if (name === 'trust proxy') {
        fastify.log.debug({ trustProxy: value }, 'trust proxy is configured at Fastify construction time');
      }
      return compat;
    },
    use(...args) {
      const { path, fns } = normalizeUseArgs(args);
      for (const fn of fns) {
        if (typeof fn !== 'function') continue;
        if (fn.length === 4) {
          errorMiddlewares.push(fn);
        } else {
          middlewares.push({ path, fn });
        }
      }
      return compat;
    },
    get(url, ...handlers) {
      registerRoute('GET', url, handlers);
      return compat;
    },
    post(url, ...handlers) {
      registerRoute('POST', url, handlers);
      return compat;
    },
    listen(port, callback) {
      fastify.listen({ port: Number(port), host: '0.0.0.0' }, (err, address) => {
        if (err) throw err;
        callback?.(address);
      });
      return fastify.server;
    },
    // Stops accepting connections and resolves once in-flight requests have
    // finished (server/shutdown.js drives it on SIGTERM, issue #368).
    close() {
      return fastify.close();
    }
  };

  function registerRoute(method, url, handlers) {
    const stack = [
      ...middlewares,
      ...handlers.flat().filter(fn => typeof fn === 'function').map(fn => ({ path: '/', fn }))
    ];
    const bodyLimit = routeBodyLimits[url];
    fastify.route({
      method,
      url,
      ...(bodyLimit ? { bodyLimit } : {}),
      handler: (request, reply) => runLegacyStack(stack, request, reply)
    });
  }

  fastify.setNotFoundHandler((request, reply) => {
    return runLegacyStack(middlewares, request, reply);
  });

  return compat;
}
