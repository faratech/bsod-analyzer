import React from 'react';
import { renderToString } from 'react-dom/server';
import { prerenderToNodeStream } from 'react-dom/static';
import { StaticRouter } from 'react-router-dom';
import { BrowserRouter } from 'react-router-dom';
import AppShell from './AppRouter';

/**
 * Server entry used only at build time (Vite SSR build + scripts/prerender.mjs).
 * Renders the app for a given route to an HTML string that is injected into
 * #root of index.html, producing a prerendered page the client then hydrates.
 *
 * Synchronous; use ONLY for "/" — its page (Home) is imported eagerly, so there
 * is no Suspense fallback and renderToString captures the full markup. Every other
 * route lazy-loads its page (React.lazy), which renderToString would render as the
 * <Loader/> fallback — use renderAsync for those.
 */
export function render(url: string): string {
  return renderToString(
    <React.StrictMode>
      <StaticRouter location={url}>
        <AppShell />
      </StaticRouter>
    </React.StrictMode>
  );
}

/**
 * Suspense-aware prerender for the lazy routes (everything except "/"). React 19's
 * prerenderToNodeStream waits for all lazy chunks / Suspense boundaries to resolve
 * before completing, so the returned HTML contains the fully-rendered page AND the
 * Suspense boundary markers the client needs to hydrate it cleanly (selective
 * hydration handles the client-side lazy chunk loading). Build-time only.
 */
export async function renderAsync(url: string): Promise<string> {
  let renderError: unknown = null;
  const { prelude } = await prerenderToNodeStream(
    <React.StrictMode>
      <StaticRouter location={url}>
        <AppShell />
      </StaticRouter>
    </React.StrictMode>,
    { onError(err) { renderError = err; } }
  );
  let html = '';
  for await (const chunk of prelude) html += Buffer.from(chunk).toString('utf-8');
  if (renderError) throw renderError;
  return html;
}

/**
 * The exact element the client mounts (see index.tsx) — exposed so a hydration
 * verification step (scripts/verify-hydration.mjs) can render/hydrate it under
 * jsdom and confirm it matches the prerendered markup. Not used in production.
 */
export function clientApp() {
  return (
    <React.StrictMode>
      <BrowserRouter>
        <AppShell />
      </BrowserRouter>
    </React.StrictMode>
  );
}
