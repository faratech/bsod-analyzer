import React from 'react';

interface State {
  hasChunkError: boolean;
}

/**
 * Error boundary that catches chunk load failures after deployments.
 * When new code is deployed, old lazy-loaded chunk URLs become 404s.
 * This boundary detects that and forces a page reload to get fresh HTML
 * with the new chunk hashes.
 */
class ChunkErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = { hasChunkError: false };

  static getDerivedStateFromError(error: Error): State | null {
    // Detect chunk load failures (Vite/webpack dynamic import errors)
    if (
      error.name === 'ChunkLoadError' ||
      error.message?.includes('Failed to fetch dynamically imported module') ||
      error.message?.includes('Loading chunk') ||
      error.message?.includes('Loading CSS chunk')
    ) {
      return { hasChunkError: true };
    }
    return null;
  }

  componentDidCatch(error: Error) {
    const isChunkError =
      error.name === 'ChunkLoadError' ||
      error.message?.includes('Failed to fetch dynamically imported module') ||
      error.message?.includes('Loading chunk') ||
      error.message?.includes('Loading CSS chunk');

    if (isChunkError) {
      // Prevent infinite reload loops: only reload once per session
      const reloadKey = 'chunk-error-reload';
      if (!sessionStorage.getItem(reloadKey)) {
        sessionStorage.setItem(reloadKey, '1');
        window.location.reload();
      }
    }
  }

  render() {
    if (this.state.hasChunkError) {
      // Fallback UI while reload happens (or if reload was already attempted)
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '60vh',
          color: 'var(--text-primary)',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          padding: '2rem',
          textAlign: 'center',
        }}>
          <h2 style={{ marginBottom: '1rem' }}>A new version is available</h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
            Please refresh the page to load the latest version.
          </p>
          <button
            onClick={() => {
              sessionStorage.removeItem('chunk-error-reload');
              window.location.reload();
            }}
            style={{
              padding: '0.75rem 1.5rem',
              backgroundColor: 'var(--brand-primary)',
              color: 'white',
              border: 'none',
              borderRadius: '0.5rem',
              cursor: 'pointer',
              fontSize: '0.875rem',
              fontWeight: 500,
            }}
          >
            Refresh Page
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ChunkErrorBoundary;
