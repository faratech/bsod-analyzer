// Session management for analyzer page
let sessionInitialized = false;

export async function initializeSession(): Promise<boolean> {
  if (sessionInitialized) {
    return true;
  }

  try {
    const response = await fetch('/api/auth/session', {
      method: 'GET',
      credentials: 'include' // Important: include cookies
    });

    if (!response.ok) {
      throw new Error('Failed to initialize session');
    }

    const data = await response.json();
    if (data.success) {
      sessionInitialized = true;
      return true;
    }
    
    return false;
  } catch (error) {
    console.error('Session initialization error:', error);
    return false;
  }
}

// Handle session errors in API responses
export function handleSessionError(error: any): boolean {
  if (error.code === 'NO_SESSION' || error.code === 'INVALID_SESSION') {
    // Session expired or invalid, need to re-initialize
    sessionInitialized = false;
    return true;
  }
  return false;
}