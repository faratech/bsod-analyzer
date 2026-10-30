function normalizeMultipartField(field) {
  if (Array.isArray(field)) return field.map(normalizeMultipartField);
  if (field && typeof field === 'object' && 'value' in field) return field.value;
  return field;
}

// How long the part iterator may stay unsettled once the request body has been
// read to the end. Parts busboy already parsed are queued and arrive within
// microtasks; only busboy's own end-of-form signal can be missing (bytes after
// the closing boundary arriving in a later read never produce one).
export const DEFAULT_MULTIPART_DRAIN_MS = 500;

// Next part, or { done: true, abandoned: true } when the body has ended and the
// iterator has not settled within drainMs of that.
function nextPartOrDrained(iterator, raw, drainMs) {
  const next = iterator.next();
  return new Promise((resolve, reject) => {
    let timer = null;
    const arm = () => {
      if (timer) return;
      timer = setTimeout(() => {
        cleanup();
        resolve({ done: true, abandoned: true });
      }, drainMs);
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      raw?.removeListener?.('end', arm);
      raw?.removeListener?.('close', arm);
    };
    next.then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); }
    );
    if (!raw) return;
    if (raw.readableEnded || raw.destroyed) arm();
    else {
      raw.once('end', arm);
      raw.once('close', arm);
    }
  });
}

export function createUploadHandler({ limits, fileFilter, drainMs = DEFAULT_MULTIPART_DRAIN_MS }) {
  return {
    single(fieldName) {
      return async (req, _res, next) => {
        try {
          if (typeof req.fastifyRequest?.parts !== 'function') {
            req.file = undefined;
            return next();
          }

          // Iterate every part to the end of the body instead of stopping at
          // the file: a field that follows the file part (or arrives in a
          // later network read) is only parsed once the remaining parts are
          // drained (#244). The iteration is bounded by the end of the request
          // body plus drainMs: an epilogue after the closing boundary that
          // arrives in a later read leaves busboy's iterator unsettled forever,
          // which would hold the route's concurrency slot.
          const raw = req.fastifyRequest.raw || req;
          const parts = req.fastifyRequest.parts({
            throwFileSizeLimit: true,
            limits: {
              fileSize: limits.fileSize,
              files: limits.files || 1,
              fields: 20,
              parts: 25
            }
          });

          let file;
          let partFields = {};
          const iterator = parts[Symbol.asyncIterator]();
          for (;;) {
            const step = await nextPartOrDrained(iterator, raw, drainMs);
            if (step.abandoned) {
              // The body is fully read; stop feeding the parser.
              raw.unpipe?.();
              break;
            }
            if (step.done) break;
            const part = step.value;
            partFields = part.fields || partFields;
            if (part.type !== 'file') continue;
            if (part.fieldname !== fieldName || file) {
              const err = new Error(`Unexpected file field "${part.fieldname}"`);
              err.code = 'LIMIT_UNEXPECTED_FILE';
              err.status = 400;
              throw err;
            }

            const buffer = await part.toBuffer();
            file = {
              fieldname: part.fieldname,
              originalname: part.filename,
              encoding: part.encoding,
              mimetype: part.mimetype,
              buffer,
              size: buffer.length
            };

            await new Promise((resolve, reject) => {
              fileFilter(req, file, (err, accepted) => {
                if (err) return reject(err);
                if (accepted === false) return reject(new Error('File upload rejected'));
                resolve();
              });
            });
          }

          if (!file) {
            req.file = undefined;
            return next();
          }

          const fields = {};
          for (const [key, value] of Object.entries(partFields)) {
            if (key !== fieldName) fields[key] = normalizeMultipartField(value);
          }
          req.body = {
            ...(req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {}),
            ...fields
          };
          req.file = file;
          next();
        } catch (error) {
          next(error);
        }
      };
    }
  };
}
