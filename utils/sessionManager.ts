// Session management for analyzer page
let sessionInitialized = false;

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
  if (error.code === 'NO_SESSION' || error.code === 'INVALID_SESSION' || error.code === 'INVALID_SIGNATURE') {
    // Session expired, invalid, or signature mismatch - need to re-initialize
    sessionInitialized = false;
    return true;
  }
  return false;
}

// Force reset session state (for manual recovery)
export function resetSession(): void {
  sessionInitialized = false;
}