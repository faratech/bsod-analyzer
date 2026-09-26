// Cached reader for the small JSON files the BigQuery scheduled queries export
// to Cloud Storage (bigquery/*.sql). Cloud Run never queries BigQuery: it reads
// these files, re-checks an object's generation at most every `checkIntervalMs`,
// and downloads again only when the generation changed. Files are
// newline-delimited JSON (EXPORT DATA format=JSON), parsed into an array of rows.
import { createGcpMetadataAuth } from './gcpMetadata.js';

const STORAGE = 'https://storage.googleapis.com/storage/v1';
const DEFAULT_CHECK_INTERVAL_MS = 10 * 60 * 1000;

export function parseNdjson(text) {
  return String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

export function createGcsJsonReader({
  bucket,
  projectId,
  getAccessToken,
  fetchImpl = globalThis.fetch,
  checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
  now = () => Date.now()
} = {}) {
  if (!bucket || !/^[a-z0-9._-]+$/.test(bucket)) throw new TypeError('A valid bucket name is required');
  const { accessToken } = createGcpMetadataAuth({ projectId: projectId || 'unused', getAccessToken, fetchImpl });
  const cache = new Map(); // path -> { generation, rows, checkedAt, inFlight }

  async function request(url) {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${await accessToken()}` },
      signal: AbortSignal.timeout(15_000)
    });
    if (!res.ok) {
      const error = new Error(`Cloud Storage HTTP ${res.status} for ${url.replace(/\?.*$/, '')}`);
      error.status = res.status;
      throw error;
    }
    return res;
  }

  async function refresh(path, entry) {
    const object = `${STORAGE}/b/${bucket}/o/${encodeURIComponent(path)}`;
    const meta = await (await request(`${object}?fields=generation`)).json();
    if (entry?.rows && entry.generation === meta.generation) {
      return { ...entry, checkedAt: now() };
    }
    const text = await (await request(`${object}?alt=media&ifGenerationMatch=${meta.generation}`)).text();
    return { generation: meta.generation, rows: parseNdjson(text), checkedAt: now() };
  }

  // Rows of the file at `path`. Serves the cached copy between checks and keeps
  // serving it if a refresh fails; returns null only when nothing was ever read.
  async function read(path) {
    const entry = cache.get(path);
    if (entry?.rows && now() - entry.checkedAt < checkIntervalMs) return entry.rows;
    if (entry?.inFlight) return entry.inFlight;
    const inFlight = refresh(path, entry)
      .then(next => {
        cache.set(path, next);
        return next.rows;
      })
      .catch(error => {
        if (entry?.rows) {
          cache.set(path, { ...entry, inFlight: null, checkedAt: now() });
          console.warn('[gcs] refresh failed, serving cached copy:', path, error?.message || error);
          return entry.rows;
        }
        cache.delete(path);
        throw error;
      });
    cache.set(path, { ...(entry || {}), inFlight });
    return inFlight;
  }

  return { read };
}
