// Cloud Run service-account credentials from the metadata server, shared by the
// BigQuery clients (stats reads, corpus writes). Tests inject projectId /
// getAccessToken / fetchImpl instead of reaching the metadata server.
const METADATA = 'http://metadata.google.internal/computeMetadata/v1';

export function createGcpMetadataAuth({ projectId, getAccessToken, fetchImpl = globalThis.fetch } = {}) {
  let token = null; // { value, expiresAt }
  let project = projectId || null;
  let tokenRequest = null; // parallel callers share one in-flight fetch

  async function metadata(path) {
    const res = await fetchImpl(`${METADATA}/${path}`, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(2000)
    });
    if (!res.ok) throw new Error(`metadata ${path} HTTP ${res.status}`);
    return res;
  }

  async function accessToken() {
    if (getAccessToken) return getAccessToken();
    if (token && token.expiresAt - 60_000 > Date.now()) return token.value;
    tokenRequest ??= (async () => {
      try {
        const body = await (await metadata('instance/service-accounts/default/token')).json();
        token = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in || 0) * 1000 };
        return token.value;
      } finally {
        tokenRequest = null;
      }
    })();
    return tokenRequest;
  }

  async function projectIdentifier() {
    if (!project) project = (await (await metadata('project/project-id')).text()).trim();
    return project;
  }

  return { accessToken, projectIdentifier };
}
