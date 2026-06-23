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

const { render } = await import(pathToFileURL(ssrEntry).href);
if (typeof render !== 'function') fail('entry-server did not export a render() function.');

// Render the homepage to static HTML.
const appHtml = render('/');
if (!appHtml || !appHtml.includes('Decode Your Windows Crash Screen')) {
  fail('Prerendered homepage HTML is empty or missing the hero — aborting so we never ship a blank page.');
}

const indexHtml = fs.readFileSync(indexPath, 'utf-8');
if (!indexHtml.includes(ROOT_MARKER)) fail(`root marker "${ROOT_MARKER}" not found in dist/index.html.`);

const prerendered = indexHtml.replace(ROOT_MARKER, `<div id="root">${appHtml}</div>`);
fs.writeFileSync(path.join(distDir, 'index.prerendered.html'), prerendered);

console.log(
  `[prerender] wrote dist/index.prerendered.html ` +
  `(${Buffer.byteLength(prerendered)} bytes; #root markup ${appHtml.length} chars)`
);
