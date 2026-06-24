import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const distDir = path.join(root, 'dist');
const indexPath = path.join(distDir, 'index.html');
const ssrEntry = path.join(root, 'dist-ssr', 'entry-server.js');
const ROOT_MARKER = '<div id="root"></div>';

function fail(msg) {
  console.error(`[prerender] ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(indexPath)) fail('dist/index.html not found — run vite build + generate-sri first.');
if (!fs.existsSync(ssrEntry)) fail('dist-ssr/entry-server.js not found — run the SSR build first.');

const { render, renderAsync } = await import(pathToFileURL(ssrEntry).href);
if (typeof render !== 'function') fail('entry-server did not export a render() function.');
if (typeof renderAsync !== 'function') fail('entry-server did not export a renderAsync() function.');

const indexHtml = fs.readFileSync(indexPath, 'utf-8');
if (!indexHtml.includes(ROOT_MARKER)) fail(`root marker "${ROOT_MARKER}" not found in dist/index.html.`);

// Inject rendered app markup into the SRI'd index.html template (prerender runs
// after generate-sri, so integrity attributes are already present and inherited).
function writePrerendered(file, appHtml) {
  const out = indexHtml.replace(ROOT_MARKER, `<div id="root">${appHtml}</div>`);
  fs.writeFileSync(file, out);
  return Buffer.byteLength(out);
}

// --- Homepage: Home is eager, so the synchronous render captures it fully. ---
const homeHtml = render('/');
if (!homeHtml || !homeHtml.includes('Decode Your Windows Crash Screen')) {
  fail('Prerendered homepage HTML is empty or missing the hero — aborting so we never ship a blank page.');
}
const homeBytes = writePrerendered(path.join(distDir, 'index.prerendered.html'), homeHtml);
console.log(`[prerender] / -> index.prerendered.html (${homeBytes} bytes; #root ${homeHtml.length} chars)`);

// --- Inner routes: each page is React.lazy(), so they need the Suspense-aware
// renderAsync. Each result is validated against a content marker so we never ship a
// page that only captured the <Loader/> fallback (i.e. the lazy chunk didn't resolve).
// A route that errors or doesn't resolve is SKIPPED (not fatal) — it simply falls
// back to the client-rendered shell, so the build never breaks on one bad route.
// Filenames are <route>.html; server.js scans dist/prerendered/ and serves each by route.
const ROUTES = [
  { path: '/about',         file: 'about.html',         marker: 'Our Mission' },
  { path: '/documentation', file: 'documentation.html', marker: 'Getting Started' },
  { path: '/donate',        file: 'donate.html',        marker: 'Why Donate' },
  { path: '/analyzer',      file: 'analyzer.html',      marker: 'BSOD Dump Analyzer' },
];

const prerenderedDir = path.join(distDir, 'prerendered');
fs.mkdirSync(prerenderedDir, { recursive: true });

let ok = 0;
let skipped = 0;
for (const r of ROUTES) {
  try {
    const html = await renderAsync(r.path);
    if (!html || !html.includes(r.marker)) {
      console.warn(
        `[prerender] ${r.path} SKIPPED: content marker "${r.marker}" not found ` +
        `(${html ? html.length : 0} chars) — route falls back to the client-rendered shell.`
      );
      skipped++;
      continue;
    }
    const bytes = writePrerendered(path.join(prerenderedDir, r.file), html);
    console.log(`[prerender] ${r.path} -> prerendered/${r.file} (${bytes} bytes; #root ${html.length} chars)`);
    ok++;
  } catch (e) {
    console.warn(
      `[prerender] ${r.path} SKIPPED: render error — ${e && e.message ? e.message : e}. ` +
      `Route falls back to the client-rendered shell.`
    );
    skipped++;
  }
}

console.log(`[prerender] done: 1 homepage + ${ok} inner route(s) prerendered, ${skipped} skipped.`);
