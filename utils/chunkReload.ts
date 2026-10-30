/**
 * Recovery from stale lazy chunks after a deploy. The old HTML references
 * chunk hashes the new revision no longer serves (missing /assets/* is a 404),
 * so the import rejects and only a reload (fresh HTML, new hashes) recovers.
 */

import React, { useEffect } from 'react';

/** When the last automatic reload happened (ms since the epoch). */
export const CHUNK_RELOAD_KEY = 'chunk-error-reload';
/** `<period start>:<reloads in that period>` for the reload budget. */
export const CHUNK_RELOAD_COUNT_KEY = 'chunk-error-reload-count';

/** A reload within this window is assumed to have failed already: no loop. */
export const CHUNK_RELOAD_WINDOW_MS = 10_000;
/**
 * At most this many automatic reloads per CHUNK_RELOAD_PERIOD_MS. The window
 * alone cannot stop a chunk that keeps failing when a reload cycle (HTML,
 * entry JS, lazy import) takes longer than the window (issue #308).
 */
export const CHUNK_RELOAD_BUDGET = 2;
export const CHUNK_RELOAD_PERIOD_MS = 5 * 60_000;

// What each engine (and Vite) says when a dynamic import or its CSS fails.
const CHUNK_ERROR_PATTERNS = [
  /Failed to fetch dynamically imported module/i, // Chrome, Edge
  /error loading dynamically imported module/i, // Firefox
  /Importing a module script failed/i, // Safari
  /Unable to preload CSS/i, // Vite's CSS preload helper
  /Loading (CSS )?chunk/i, // webpack-style messages
];

export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === 'ChunkLoadError') return true;
  return typeof message === 'string' && CHUNK_ERROR_PATTERNS.some(pattern => pattern.test(message));
}

function readGuard(storage: Storage): number | null {
  const stored = Number(storage.getItem(CHUNK_RELOAD_KEY));
  return Number.isFinite(stored) && stored > 0 ? stored : null;
}

// Reloads spent in the current budget period; a missing, malformed or
// expired record starts a new period at `now`.
function readBudget(storage: Storage, now: number): { start: number; count: number } {
  const match = /^(\d+):(\d+)$/.exec(storage.getItem(CHUNK_RELOAD_COUNT_KEY) || '');
  const start = match ? Number(match[1]) : NaN;
  const count = match ? Number(match[2]) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(count) || now < start || now - start >= CHUNK_RELOAD_PERIOD_MS) {
    return { start: now, count: 0 };
  }
  return { start, count };
}

/**
 * Reload the page unless this tab already reloaded for a chunk error within
 * CHUNK_RELOAD_WINDOW_MS, or already spent CHUNK_RELOAD_BUDGET reloads in the
 * current CHUNK_RELOAD_PERIOD_MS. Returns whether a reload was started. The
 * guard is cleared once a lazy route commits (lazyRoute), and both limits
 * expire, so a later deploy in the same tab reloads again.
 */
export function guardedReload(win: Window = window): boolean {
  try {
    const storage = win.sessionStorage;
    const last = readGuard(storage);
    const now = Date.now();
    // A legacy '1' flag parses to 1 (1970), which is stale by definition.
    if (last !== null && now - last >= 0 && now - last < CHUNK_RELOAD_WINDOW_MS) return false;
    const budget = readBudget(storage, now);
    if (budget.count >= CHUNK_RELOAD_BUDGET) return false;
    storage.setItem(CHUNK_RELOAD_COUNT_KEY, `${budget.start}:${budget.count + 1}`);
    storage.setItem(CHUNK_RELOAD_KEY, String(now));
  } catch {
    // Without storage there is no loop guard; leave the fallback to the user.
    return false;
  }
  win.location.reload();
  return true;
}

export function clearChunkReloadGuard(win: Window = window): void {
  try {
    win.sessionStorage.removeItem(CHUNK_RELOAD_KEY);
    win.sessionStorage.removeItem(CHUNK_RELOAD_COUNT_KEY);
  } catch {
    // Storage unavailable: nothing to clear.
  }
}

/**
 * Vite dispatches `vite:preloadError` on window when a lazy chunk's JS or CSS
 * preload fails; the guarded reload fetches the new HTML. preventDefault()
 * stops Vite rethrowing, which makes the import resolve to undefined, so it is
 * called only while a reload is under way. When the reload is refused (guard
 * active, storage blocked) Vite rethrows, lazyRoute reports a ChunkLoadError
 * and the boundary shows the update fallback (issue #309). Returns a disposer.
 */
export function installChunkPreloadRecovery(win: Window): () => void {
  const onPreloadError = (event: Event) => {
    if (guardedReload(win)) event.preventDefault();
  };
  win.addEventListener('vite:preloadError', onPreloadError);
  return () => win.removeEventListener('vite:preloadError', onPreloadError);
}

/**
 * React.lazy for a route chunk: any rejection of the import is reported as a
 * ChunkLoadError, so the boundary recovers even from messages not listed in
 * CHUNK_ERROR_PATTERNS (engines word network failures differently). Once the
 * route has loaded and committed, the last reload (if any) worked, so the
 * reload guard is cleared then, and never while the route is still loading.
 */
export function lazyRoute<T extends React.ComponentType<any>>(
  load: () => Promise<{ default: T }>,
): React.LazyExoticComponent<T> {
  return React.lazy(() => load().then(
    module => ({ default: clearsReloadGuardOnCommit(module.default) }),
    (cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw Object.assign(new Error(message), { name: 'ChunkLoadError', cause });
    },
  ));
}

function clearsReloadGuardOnCommit<T extends React.ComponentType<any>>(Component: T): T {
  const Committed = (props: React.ComponentProps<T>) => {
    useEffect(() => {
      clearChunkReloadGuard();
    }, []);
    return React.createElement(Component, props);
  };
  Committed.displayName = `LazyRoute(${Component.displayName || Component.name || 'Component'})`;
  return Committed as unknown as T;
}
