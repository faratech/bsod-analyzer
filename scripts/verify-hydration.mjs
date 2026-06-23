/**
 * Hydration verification gate (run after `npm run build:ssr`).
 *
 * 1. Diffs the server-prerendered markup (StaticRouter "/") against the client's
 *    first render (BrowserRouter "/") — React compares exactly these during
 *    hydration, so byte-equality means no mismatch.
 * 2. Actually runs hydrateRoot() under jsdom against the prerendered markup and
 *    fails on any React hydration error/warning.
 *
 * Requires jsdom (install locally with: npm i --no-save jsdom).
 */
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const ssrEntry = pathToFileURL(path.join(root, 'dist-ssr', 'entry-server.js')).href;

const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>', {
  url: 'https://bsod.windowsforum.com/',
  pretendToBeVisual: true,
});

// Expose a browser-like environment so post-hydration effects don't throw.
const { window } = dom;
const setGlobal = (key, val) => {
  try { globalThis[key] = val; }
  catch { try { Object.defineProperty(globalThis, key, { value: val, configurable: true, writable: true }); } catch { /* read-only host global */ } }
};
const NoopObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
window.matchMedia = window.matchMedia || (() => ({ matches: false, media: '', onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }));
Object.defineProperty(window, 'scrollTo', { value: () => {}, configurable: true });
// In-memory localStorage (jsdom here has none; real browsers do).
const _ls = new Map();
const localStorageMock = {
  getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => { _ls.set(k, String(v)); },
  removeItem: (k) => { _ls.delete(k); },
  clear: () => _ls.clear(),
  key: (i) => [..._ls.keys()][i] ?? null,
  get length() { return _ls.size; },
};
try { Object.defineProperty(window, 'localStorage', { value: localStorageMock, configurable: true }); } catch { /* ignore */ }
window.requestIdleCallback = window.requestIdleCallback || ((cb) => setTimeout(() => cb({ timeRemaining: () => 0, didTimeout: true }), 0));
window.IntersectionObserver = window.IntersectionObserver || NoopObserver;
window.ResizeObserver = window.ResizeObserver || NoopObserver;
setGlobal('window', window);
setGlobal('document', window.document);
if (!globalThis.navigator) setGlobal('navigator', window.navigator);
setGlobal('localStorage', localStorageMock);
setGlobal('IntersectionObserver', window.IntersectionObserver);
setGlobal('ResizeObserver', window.ResizeObserver);
setGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(Date.now()), 0));
setGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
setGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const fail = (msg) => { console.error(`❌ HYDRATION CHECK FAILED: ${msg}`); process.exit(1); };

const { render, clientApp } = await import(ssrEntry);
const { renderToString } = await import('react-dom/server');
const { hydrateRoot } = await import('react-dom/client');

// --- Check 1: server markup vs client first render must be byte-identical ---
const serverHtml = render('/');
const clientHtml = renderToString(clientApp());
if (serverHtml !== clientHtml) {
  // Locate the first divergence to make debugging easy.
  let i = 0;
  while (i < serverHtml.length && i < clientHtml.length && serverHtml[i] === clientHtml[i]) i++;
  console.error('--- server around first diff ---\n' + serverHtml.slice(Math.max(0, i - 80), i + 80));
  console.error('--- client around first diff ---\n' + clientHtml.slice(Math.max(0, i - 80), i + 80));
  fail(`StaticRouter and BrowserRouter renders diverge at offset ${i} (would cause a hydration mismatch).`);
}
console.log(`✓ server/client first render identical (${serverHtml.length} chars)`);

// --- Check 2: real hydrateRoot under jsdom, fail on any hydration warning ---
const rootEl = document.getElementById('root');
rootEl.innerHTML = serverHtml;

const errors = [];
const origError = console.error;
console.error = (...args) => {
  if (errors.length < 100) { errors.push(args.map(String).join(' ')); origError(...args); }
};

hydrateRoot(rootEl, clientApp());
await new Promise((r) => setTimeout(r, 200)); // let effects flush
console.error = origError;

const hydrationErrors = errors.filter((e) =>
  /hydrat|did not match|server html|mismatch|text content does not match/i.test(e)
);
if (hydrationErrors.length) {
  hydrationErrors.forEach((e) => console.error('  • ' + e.slice(0, 200)));
  fail(`${hydrationErrors.length} hydration error(s) reported by React.`);
}

console.log('✓ hydrateRoot completed with no hydration mismatch');
console.log('✅ HYDRATION CHECK PASSED');
// jsdom keeps timers/handles open, so force a clean exit.
process.exit(0);
