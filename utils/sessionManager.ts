// Session management for analyzer page
let sessionInitialized = false;
let lastRefreshTime = 0;
let refreshInterval: ReturnType<typeof setInterval> | null = null;

// Refresh session every 20 minutes (session expires in 1 hour)
const REFRESH_INTERVAL_MS = 20 * 60 * 1000;
// Minimum time between refreshes (prevent rapid refreshes)
const MIN_REFRESH_GAP_MS = 5 * 60 * 1000;

export async function initializeSession(force: boolean = false): Promise<boolean> {
  if (sessionInitialized && !force) {
    console.log('[Session] Already initialized, skipping');
    return true;
  }

  try {
    console.log('[Session] Initializing session...');
    const response = await fetch('/api/auth/session', {
      method: 'GET',
      credentials: 'include' // Important: include cookies
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      console.error('[Session] Init failed:', response.status, data);
      if (data.code === 'TURNSTILE_REQUIRED') {
        // This is expected - user needs to complete Turnstile first
        return false;
      }
      throw new Error('Failed to initialize session');
    }

    const data = await response.json();
    if (data.success) {
      sessionInitialized = true;
      console.log('[Session] Initialized successfully');
      return true;
    }

    console.error('[Session] Init returned success=false');
    return false;
  } catch (error) {
    console.error('[Session] Initialization error:', error);
    return false;
  }
}

// Handle session errors in API responses
export function handleSessionError(error: { code?: string; [key: string]: unknown }): boolean {
  if (error.code === 'NO_SESSION' || error.code === 'INVALID_SESSION') {
    // Session expired or invalid - need to re-initialize
    sessionInitialized = false;
    return true;
  }
  return false;
}

// Force reset session state (for manual recovery)
export function resetSession(): void {
  sessionInitialized = false;
  lastRefreshTime = 0;
}

// Silently refresh session to keep it alive
async function refreshSession(): Promise<boolean> {
  const now = Date.now();

  // Don't refresh too frequently
  if (now - lastRefreshTime < MIN_REFRESH_GAP_MS) {
    return true;
  }

  try {
    const response = await fetch('/api/auth/session', {
      method: 'GET',
      credentials: 'include'
    });

    if (response.ok) {
      lastRefreshTime = now;
      console.log('[Session] Refreshed successfully');
      return true;
    }

    // Session invalid - mark for re-initialization
    sessionInitialized = false;
    return false;
  } catch {
    // Network error - don't invalidate session, just skip refresh
    return true;
  }
}

// Handle visibility change - refresh when user returns to tab
function handleVisibilityChange(): void {
  if (document.visibilityState === 'visible' && sessionInitialized) {
    const timeSinceRefresh = Date.now() - lastRefreshTime;
    // Refresh if it's been more than half the interval since last refresh
    if (timeSinceRefresh > REFRESH_INTERVAL_MS / 2) {
      refreshSession();
    }
  }
}

// Start automatic session refresh (call after successful init)
export function startSessionRefresh(): void {
  if (refreshInterval) return; // Already running

  lastRefreshTime = Date.now();

  // Periodic refresh while tab is visible
  refreshInterval = setInterval(() => {
    if (document.visibilityState === 'visible' && sessionInitialized) {
      refreshSession();
    }
  }, REFRESH_INTERVAL_MS);

  // Refresh when user returns to tab after being away
  document.addEventListener('visibilitychange', handleVisibilityChange);

  console.log('[Session] Auto-refresh started (every 20 min when active)');
}

// Stop automatic session refresh
export function stopSessionRefresh(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
  document.removeEventListener('visibilitychange', handleVisibilityChange);
}