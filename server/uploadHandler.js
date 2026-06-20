function normalizeMultipartField(field) {
  if (Array.isArray(field)) return field.map(normalizeMultipartField);
  if (field && typeof field === 'object' && 'value' in field) return field.value;
  return field;
}

export function createUploadHandler({ limits, fileFilter }) {
  return {
    single(fieldName) {
      return async (req, _res, next) => {
        try {
          if (typeof req.fastifyRequest?.file !== 'function') {
            req.file = undefined;
            return next();
          }

          const part = await req.fastifyRequest.file({
            throwFileSizeLimit: true,
            limits: {
              fileSize: limits.fileSize,
              files: limits.files || 1,
              fields: 20,
              parts: 25
            }
          });

          if (!part) {
            req.file = undefined;
            return next();
          }
          if (part.fieldname !== fieldName) {
            const err = new Error(`Unexpected file field "${part.fieldname}"`);
            err.code = 'LIMIT_UNEXPECTED_FILE';
            err.status = 400;
            throw err;
          }

          const buffer = await part.toBuffer();
          const file = {
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

          const fields = {};
          for (const [key, value] of Object.entries(part.fields || {})) {
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
