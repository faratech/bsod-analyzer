import React from 'react';
import {
  clearChunkReloadGuard,
  guardedReload,
  isChunkLoadError,
} from '../utils/chunkReload';

interface Props {
  /** Changing it (the route path) clears a caught error, so navigation recovers. */
  resetKey?: string;
}

interface State {
  error: 'chunk' | 'render' | null;
}

/**
 * Error boundary around the routes. A lazy chunk that fails to load (old chunk
 * hashes after a deploy) shows "A new version is available" and reloads within
 * the guardedReload limits; the guard is cleared when a lazy route commits
 * (lazyRoute), not here. Any other render error shows a generic fallback with
 * a refresh button instead of letting React unmount the whole page.
 */
class ChunkErrorBoundary extends React.Component<React.PropsWithChildren<Props>, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: isChunkLoadError(error) ? 'chunk' : 'render' };
  }

  componentDidCatch(error: unknown) {
    if (isChunkLoadError(error) && typeof window !== 'undefined') {
      guardedReload(window);
    }
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.error !== null && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (error === null) return this.props.children;

    return (
      <div role="alert" style={{
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
        <h2 style={{ marginBottom: '1rem' }}>
          {error === 'chunk' ? 'A new version is available' : 'Something went wrong'}
        </h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
          {error === 'chunk'
            ? 'Please refresh the page to load the latest version.'
            : 'This page failed to display. Refreshing usually fixes it.'}
        </p>
        <button
          onClick={() => {
            clearChunkReloadGuard();
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
}

export default ChunkErrorBoundary;
