import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CSP_HEADER,
  CSP_EMBED_HEADER,
  computeInlineScriptSources,
  createSecurityHeadersMiddleware
} from '../server/securityHeaders.js';
import { createFastifyCompatApp } from '../server/fastifyCompat.js';

function buildApp(middleware) {
  const app = createFastifyCompatApp({ bodyLimit: 1024 });
  app.use(middleware);
  // NOTE: every path we fetch must be registered — unmatched requests under
  // the compat layer hang instead of 404ing.
  app.get('/about', (_req, res) => res.status(200).send('about'));
  app.get('/analyzer', (_req, res) => res.status(200).send('analyzer'));
  app.get('/stats', (_req, res) => res.status(200).send('stats'));
  app.get('/stats/embed', (_req, res) => res.status(200).send('embed'));
  app.get('/stats/embed/x', (_req, res) => res.status(200).send('embed-sub'));
  return app;
}

function headersOf(res) {
  return {
    xfo: res.headers.get('x-frame-options'),
    csp: res.headers.get('content-security-policy')
  };
}

async function listenCompat(app) {
  await new Promise(resolve => app.listen(0, resolve));
  const address = app.fastify.server.address();
  return { port: address.port, close: () => app.fastify.close() };
}

test('default paths keep SAMEORIGIN and strict frame-ancestors', async () => {
  const server = await listenCompat(buildApp(createSecurityHeadersMiddleware()));
  try {
    for (const path of ['/about', '/analyzer']) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { connection: 'close' } });
      assert.equal(res.status, 200);
      const { xfo, csp } = headersOf(res);
      assert.equal(xfo, 'SAMEORIGIN', path);
      // frame-ancestors must be exactly 'self' — no forum origins.
      assert.match(csp, /frame-ancestors 'self'(;|$)/, path);
      assert.doesNotMatch(csp, /frame-ancestors[^;]*windowsforum/, path);
    }
  } finally {
    await server.close();
  }
});

test('only the embed route drops XFO and widens frame-ancestors', async () => {
  const server = await listenCompat(buildApp(createSecurityHeadersMiddleware()));
  try {
    const opts = { headers: { connection: 'close' } };
    const embed = await fetch(`http://127.0.0.1:${server.port}/stats/embed`, opts);
    assert.equal(embed.status, 200);
    const { xfo, csp } = headersOf(embed);
    assert.equal(xfo, null);
    assert.match(csp, /frame-ancestors 'self' https:\/\/windowsforum\.com https:\/\/\*\.windowsforum\.com/);
    assert.match(csp, /frame-ancestors 'self' https:\/\/windowsforum\.com https:\/\/\*\.windowsforum\.com/);
    // Subpaths of an embeddable route stay embeddable.
    const sub = await fetch(`http://127.0.0.1:${server.port}/stats/embed/x`, opts);
    assert.equal(sub.status, 200);
    assert.equal(headersOf(sub).xfo, null);
    // Everything else stays locked down.
    const other = await fetch(`http://127.0.0.1:${server.port}/stats`, opts);
    assert.equal(other.status, 200);
    assert.equal(headersOf(other).xfo, 'SAMEORIGIN');
  } finally {
    await server.close();
  }
});

test('computeInlineScriptSources hashes inline scripts only (issue #74)', () => {
  const html = `<html><head>
    <script src="/assets/app.js"></script>
    <script>window.__FLAG__ = false;</script>
    <script type="application/json">{"seed":1}</script>
    <script>   </script>
  </head></html>`;
  const sources = computeInlineScriptSources(html, {
    sha256: (content) => `hash-${content.trim().length}`
  });
  // External and whitespace-only scripts are skipped; each unique inline
  // script contributes exactly one source expression.
  assert.equal(sources.length, 2);
  assert.ok(sources.every(s => /^'sha256-hash-\d+'$/.test(s)));
});

test('report-only mode enforces the legacy policy and stages the hashed policy', async () => {
  const middleware = createSecurityHeadersMiddleware({ cspMode: 'report-only' });
  middleware.updateInlineScriptHashes(["'sha256-abc='"]);
  const server = await listenCompat(buildApp(middleware));
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/about`, { headers: { connection: 'close' } });
    const csp = response.headers.get('content-security-policy');
    const reportOnly = response.headers.get('content-security-policy-report-only');
    assert.match(csp, /script-src[^;]*'unsafe-inline'/);
    assert.ok(reportOnly, 'report-only header must be present once hashes are known');
    assert.match(reportOnly, /script-src[^;]*'sha256-abc='/);
    assert.doesNotMatch(reportOnly, /script-src[^;]*'unsafe-inline'/);
  } finally {
    await server.close();
  }
});

test('enforce mode replaces unsafe-inline with the hash sources', async () => {
  const middleware = createSecurityHeadersMiddleware({ cspMode: 'enforce' });
  middleware.updateInlineScriptHashes(["'sha256-xyz='", "'sha256-abc='"]);
  const server = await listenCompat(buildApp(middleware));
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/about`, { headers: { connection: 'close' } });
    const csp = response.headers.get('content-security-policy');
    // style-src legitimately keeps 'unsafe-inline' (AdSense stylesheets);
    // script-src must not have it.
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
    assert.match(csp, /script-src[^;]*'sha256-abc='/);
    assert.match(csp, /'sha256-xyz='/);
    assert.match(csp, /wasm-unsafe-eval/, 'WebAssembly stays available for xxhash-wasm');
    assert.equal(response.headers.get('content-security-policy-report-only'), null);
  } finally {
    await server.close();
  }
});

test('updateInlineScriptHashes rejects malformed source expressions', () => {
  const middleware = createSecurityHeadersMiddleware({ cspMode: 'enforce' });
  middleware.updateInlineScriptHashes(['javascript:', "'unsafe-inline'", 'sha256-unquoted']);
  assert.equal(middleware.hasInlineScriptHashes(), false, 'no valid hashes => fallback stays');
  middleware.updateInlineScriptHashes(["'sha256-good='", 'javascript:']);
  assert.equal(middleware.hasInlineScriptHashes(), true, 'valid hashes survive alongside junk');
});

test('report-only policy omits directives browsers ignore in report-only mode', async () => {
  const middleware = createSecurityHeadersMiddleware({ cspMode: 'report-only' });
  middleware.updateInlineScriptHashes(["'sha256-abc='"]);
  const server = await listenCompat(buildApp(middleware));
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/about`, { headers: { connection: 'close' } });
    const csp = response.headers.get('content-security-policy');
    const reportOnly = response.headers.get('content-security-policy-report-only');
    // Chrome warns once per page load for every ignored directive, drowning the
    // violation reports the staged rollout is meant to surface.
    assert.doesNotMatch(reportOnly, /upgrade-insecure-requests/);
    // The enforcing policy still upgrades — only the report-only copy drops it.
    assert.match(csp, /upgrade-insecure-requests/);
  } finally {
    await server.close();
  }
});

test('worker-src is declared so the service worker is not judged by script-src', async () => {
  const middleware = createSecurityHeadersMiddleware({ cspMode: 'enforce' });
  middleware.updateInlineScriptHashes(["'sha256-abc='"]);
  const server = await listenCompat(buildApp(middleware));
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/about`, { headers: { connection: 'close' } });
    assert.match(response.headers.get('content-security-policy'), /worker-src 'self'/);
  } finally {
    await server.close();
  }
});

// CSP keyword source expressions are only keywords when single-quoted. Unquoted,
// the parser treats them as host source expressions (i.e. a hostname), which
// grants nothing and fails silently — no header error, no console warning, just a
// capability that is quietly absent. That is how `wasm-unsafe-eval` shipped
// unquoted and broke every WebAssembly.instantiate() on the site.
const CSP_KEYWORDS = [
  'self', 'none', 'unsafe-inline', 'unsafe-eval', 'wasm-unsafe-eval',
  'unsafe-hashes', 'strict-dynamic', 'report-sample'
];

test('every CSP keyword source expression is single-quoted', async () => {
  const middleware = createSecurityHeadersMiddleware({ cspMode: 'report-only' });
  middleware.updateInlineScriptHashes(["'sha256-abc='"]);
  const server = await listenCompat(buildApp(middleware));
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/about`, { headers: { connection: 'close' } });
    const policies = [
      response.headers.get('content-security-policy'),
      response.headers.get('content-security-policy-report-only')
    ].filter(Boolean);
    assert.ok(policies.length === 2, 'both policies should be present in report-only mode');

    for (const policy of policies) {
      for (const directive of policy.split(';')) {
        const [name, ...tokens] = directive.trim().split(/\s+/);
        if (!name) continue;
        for (const token of tokens) {
          if (CSP_KEYWORDS.includes(token)) {
            assert.fail(`${name} contains bare "${token}" — CSP keywords must be written as '${token}'`);
          }
        }
      }
    }
  } finally {
    await server.close();
  }
});

test('wasm stays enabled for xxhash-wasm, quoted so the browser honours it', async () => {
  const middleware = createSecurityHeadersMiddleware({ cspMode: 'report-only' });
  middleware.updateInlineScriptHashes(["'sha256-abc='"]);
  const server = await listenCompat(buildApp(middleware));
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/about`, { headers: { connection: 'close' } });
    // The enforcing policy is the one that can actually break the client.
    assert.match(response.headers.get('content-security-policy'), /script-src[^;]*'wasm-unsafe-eval'/);
  } finally {
    await server.close();
  }
});

// --- Issue #154: the hash-based ("strict") policy is ready to enforce. ---

const WILDCARD_SCRIPT_HOSTS = [
  'https://*.cloudflare.com', 'https://*.google ', 'https://*.google.com', 'https://*.googletagmanager.com',
  'https://*.googlesyndication.com', 'https://*.doubleclick.net',
];

function scriptSrc(policy) {
  return policy.split(';').map(d => d.trim()).find(d => d.startsWith('script-src ')) + ' ';
}

async function headersFor(cspMode, path = '/about') {
  const middleware = createSecurityHeadersMiddleware({ cspMode });
  middleware.updateInlineScriptHashes(["'sha256-abc='"]);
  const server = await listenCompat(buildApp(middleware));
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { connection: 'close' } });
    return {
      csp: response.headers.get('content-security-policy'),
      reportOnly: response.headers.get('content-security-policy-report-only'),
    };
  } finally {
    await server.close();
  }
}

test('enforced strict policy: no unsafe-inline and no wildcard script hosts (issue #154)', async () => {
  for (const path of ['/about', '/stats/embed']) {
    const { csp } = await headersFor('enforce', path);
    const scripts = scriptSrc(csp);
    assert.doesNotMatch(scripts, /'unsafe-inline'/, path);
    for (const host of WILDCARD_SCRIPT_HOSTS) {
      assert.ok(!scripts.includes(`${host.trim()} `), `${path}: ${host.trim()} must not be in script-src`);
    }
    // The hosts the site's own third parties load from are still there.
    for (const host of ['https://challenges.cloudflare.com', 'https://www.googletagmanager.com',
      'https://pagead2.googlesyndication.com', 'https://www.paypalobjects.com']) {
      assert.ok(scripts.includes(`${host} `), `${path}: ${host} missing`);
    }
  }
});

test('the strict policy reports violations to /api/csp-report', async () => {
  for (const mode of ['enforce', 'report-only']) {
    const headers = await headersFor(mode);
    const strict = mode === 'enforce' ? headers.csp : headers.reportOnly;
    assert.match(strict, /report-uri \/api\/csp-report/, mode);
    // A report-to group would make Chrome skip report-uri entirely.
    assert.doesNotMatch(strict, /report-to/, mode);
    assert.match(scriptSrc(strict), /'report-sample'/, mode);
  }
});

test('report-only stages exactly the script-src that enforce would send', async () => {
  const staged = await headersFor('report-only');
  const enforced = await headersFor('enforce');
  assert.equal(scriptSrc(staged.reportOnly), scriptSrc(enforced.csp));
  // Meanwhile the legacy enforcing policy is untouched.
  assert.equal(staged.csp, CSP_HEADER);
  assert.match(scriptSrc(staged.csp), /'unsafe-inline'/);
});

test('without hashes enforce mode falls back to the legacy policy, unreported', async () => {
  const middleware = createSecurityHeadersMiddleware({ cspMode: 'enforce' });
  const server = await listenCompat(buildApp(middleware));
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/about`, { headers: { connection: 'close' } });
    assert.equal(response.headers.get('content-security-policy'), CSP_HEADER);
    assert.doesNotMatch(CSP_HEADER, /report-uri/);
  } finally {
    await server.close();
  }
});

test('computeInlineScriptSources is not fooled by a script tag inside an HTML comment', () => {
  const sha256 = content => Buffer.from(content).toString('base64');
  const html = '<head><!-- swap runs from the <script> below --><script>real()</script></head>';
  assert.deepEqual(computeInlineScriptSources(html, { sha256 }), [`'sha256-${sha256('real()')}'`]);
});

test('index.html: every inline script is hashed and nothing needs an inline event handler', async () => {
  const { JSDOM } = await import('jsdom');
  const { createHash } = await import('node:crypto');
  const html = await (await import('node:fs/promises')).readFile(new URL('../index.html', import.meta.url), 'utf8');
  const sha256 = content => createHash('sha256').update(content).digest('base64');
  const hashed = new Set(computeInlineScriptSources(html, { sha256 }));
  const { document } = new JSDOM(html).window;

  const inline = [...document.querySelectorAll('script:not([src])')]
    .filter(s => !s.type || s.type === 'text/javascript' || s.type === 'module');
  assert.ok(inline.length >= 3, 'theme, analytics and stylesheet-swap scripts are inline');
  for (const script of inline) {
    assert.ok(hashed.has(`'sha256-${sha256(script.textContent)}'`), `unhashed inline script: ${script.textContent.trim().slice(0, 60)}`);
  }

  const handlers = [...document.querySelectorAll('*')]
    .flatMap(el => [...el.attributes].filter(a => /^on/i.test(a.name)).map(a => `<${el.tagName.toLowerCase()} ${a.name}>`));
  assert.deepEqual(handlers, [], 'inline event handlers cannot be allowed by a hash-based CSP');
});
