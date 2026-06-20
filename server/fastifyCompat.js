import Fastify from 'fastify';
import fs from 'fs';
import path from 'path';

const ASSET_EXT_RE = /\.(js|css|woff2|woff|ttf|otf|eot|png|jpg|jpeg|webp|svg|ico|json|xml|txt|webmanifest)$/i;

function pathMatches(prefix, pathname) {
  if (!prefix || prefix === '/') return true;
  return pathname === prefix || pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}

function getPathname(request) {
  try {
    return new URL(request.url, 'http://localhost').pathname;
  } catch {
    return String(request.url || '').split('?')[0] || '/';
  }
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

function patchResponse(res) {
  if (res.__bsodCompatPatched) return res;
  Object.defineProperty(res, '__bsodCompatPatched', { value: true });

  res.status = function status(code) {
    res.statusCode = code;
    return res;
  };

  res.set = function set(headers) {
    for (const [key, value] of Object.entries(headers || {})) {
      res.setHeader(key, value);
    }
    return res;
  };

  res.type = function type(value) {
    res.setHeader('Content-Type', value);
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
    res.end(JSON.stringify(payload));
    return res;
  };

  res.send = function send(payload) {
    if (payload === undefined || payload === null) {
      res.end();
      return res;
    }
    if (Buffer.isBuffer(payload) || payload instanceof Uint8Array) {
      res.end(payload);
      return res;
    }
    if (typeof payload === 'object') {
      return res.json(payload);
    }
    if (!res.headersSent && !res.getHeader('Content-Type')) {
      res.setHeader('Content-Type', ASSET_EXT_RE.test(String(payload)) ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8');
    }
    res.end(String(payload));
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
  rawReq.ip = request.ip || rawReq.ip || rawReq.socket?.remoteAddress || 'unknown';
  rawReq.originalUrl = rawReq.url;
  rawReq.get = rawReq.header = function getHeader(name) {
    return rawReq.headers[String(name).toLowerCase()];
  };
  return rawReq;
}

function isEnded(res) {
  return res.writableEnded || res.destroyed;
}

function createRunner({ middlewares, errorMiddlewares }) {
  return function runLegacyStack(stack, request, reply) {
    reply.hijack();
    const req = patchRequest(request.raw, request);
    const res = patchResponse(reply.raw);

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
              if (!settled && !isEnded(res)) resolve();
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
            if (!advanced && layer.fn.length >= 3 && !isEnded(res)) {
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

    return runAt(0).catch(runErrorHandlers);
  };
}

function readRequestBody(req, limitBytes) {
  if (req.body !== undefined && req.body !== null && typeof req.body !== 'object') {
    return Promise.resolve(req.body);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limitBytes) {
        const err = new Error('request entity too large');
        err.type = 'entity.too.large';
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
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

export function staticMiddleware(root, options = {}) {
  const base = path.resolve(root);
  const maxAge = options.maxAge === '1y' ? 31536000 : Number.parseInt(options.maxAge || '0', 10) || 0;
  const setHeaders = typeof options.setHeaders === 'function' ? options.setHeaders : null;

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

    fs.stat(filePath, (statErr, stat) => {
      if (statErr || !stat.isFile()) return next();
      if (setHeaders) setHeaders(res, filePath, stat);
      if (!res.getHeader('Cache-Control') && maxAge > 0) {
        res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
      }
      res.setHeader('Last-Modified', stat.mtime.toUTCString());
      res.setHeader('ETag', `W/"${stat.size.toString(16)}-${Number(stat.mtimeMs).toString(16)}"`);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(filePath).on('error', next).pipe(res);
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
  const fastify = Fastify({
    bodyLimit: options.bodyLimit || 1024 * 1024,
    trustProxy: options.trustProxy || false,
    logger: false,
    routerOptions: {
      ignoreTrailingSlash: true
    }
  });

  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser(/^application\/json\b/i, function jsonPassthrough(_request, payload, done) {
    done(null, payload);
  });

  const middlewares = [];
  const errorMiddlewares = [];
  const runLegacyStack = createRunner({ middlewares, errorMiddlewares });

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
    }
  };

  function registerRoute(method, url, handlers) {
    const stack = [
      ...middlewares,
      ...handlers.flat().filter(fn => typeof fn === 'function').map(fn => ({ path: '/', fn }))
    ];
    fastify.route({
      method,
      url,
      handler: (request, reply) => runLegacyStack(stack, request, reply)
    });
  }

  fastify.setNotFoundHandler((request, reply) => {
    return runLegacyStack(middlewares, request, reply);
  });

  return compat;
}
