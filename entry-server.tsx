import React from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { BrowserRouter } from 'react-router-dom';
import AppShell from './AppRouter';

/**
 * Server entry used only at build time (Vite SSR build + scripts/prerender.mjs).
 * Renders the app for a given route to an HTML string that is injected into
 * #root of index.html, producing a prerendered page the client then hydrates.
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
