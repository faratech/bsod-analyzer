// Maintenance mode: a single env flag (MAINTENANCE_MODE=true) short-circuits
// every route except /health with a 503 + Retry-After, so the site can be
// taken down and brought back with `gcloud run services update
// --update-env-vars` — no rebuild, no redeploy. Kept in server/ (not inline in
// server.js) so the gate and the page stay unit-testable.

const MAINTENANCE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Temporary Maintenance — BSOD Analyzer</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #0b1020;
    color: #dbe2f0;
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    padding: 24px;
  }
  .card {
    max-width: 560px;
    text-align: center;
    border: 1px solid #232c45;
    border-radius: 12px;
    padding: 48px 40px;
    background: #101731;
  }
  h1 { margin: 0 0 12px; font-size: 1.6rem; color: #f4f7ff; }
  .code {
    font-family: Consolas, monospace;
    font-size: 2.4rem;
    color: #4da3ff;
    margin-bottom: 8px;
  }
  p { line-height: 1.6; margin: 12px 0; color: #aab6d0; }
  a { color: #4da3ff; }
</style>
</head>
<body>
  <main class="card">
    <div class="code">0x00000000</div>
    <h1>Briefly offline for maintenance</h1>
    <p>The BSOD Analyzer is temporarily down while we perform maintenance.
       No crash dumps were harmed &mdash; everything will be back shortly.</p>
    <p>In the meantime, the discussion continues at
       <a href="https://windowsforum.com/">windowsforum.com</a>.</p>
  </main>
</body>
</html>
`;

export function isMaintenanceMode(env = process.env) {
  return env.MAINTENANCE_MODE === 'true';
}

export function createMaintenanceMiddleware({
  enabled = isMaintenanceMode,
  log = console
} = {}) {
  return function maintenanceMiddleware(req, res, next) {
    // /health stays truthful so Cloud Run probes, uptime checks, and the
    // deploy verification step keep working while the site is down.
    if (req.path === '/health') return next();
    if (!enabled()) return next();
    log.warn?.('maintenance_page_served', { path: req.path });
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': '3600',
      'X-Robots-Tag': 'noindex'
    });
    return res.status(503).send(MAINTENANCE_HTML);
  };
}
