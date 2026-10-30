import { useEffect, useRef, useState, useCallback, memo, forwardRef, useImperativeHandle } from 'react';

interface TurnstileOptions {
  sitekey: string;
  'refresh-expired'?: 'auto' | 'manual' | 'never';
  'refresh-timeout'?: 'auto' | 'manual' | 'never';
  'retry'?: 'auto' | 'never';
  'retry-interval'?: number;
  callback?: (token: string) => void;
  'error-callback'?: () => void;
  'expired-callback'?: () => void;
  'timeout-callback'?: () => void;
  action?: string;
  cdata?: string;
}

declare global {
  interface Window {
    turnstile: {
      render: (element: string | HTMLElement, options: TurnstileOptions) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

interface CloudflareTurnstileProps {
  siteKey: string;
  onSuccess: (token: string) => void;
  onError?: () => void;
  onExpire?: () => void;
  action?: string;
  cdata?: string;
  /** How long to wait for the Turnstile API before reporting an error. */
  loadTimeoutMs?: number;
}

/** Imperative handle: reset() asks the widget for a fresh single-use token. */
export interface CloudflareTurnstileHandle {
  reset: () => void;
}

const TURNSTILE_SCRIPT_SELECTOR = 'script[src*="challenges.cloudflare.com/turnstile"]';

const CloudflareTurnstile = memo(forwardRef<CloudflareTurnstileHandle, CloudflareTurnstileProps>(({
  siteKey,
  onSuccess,
  onError,
  onExpire,
  action = 'file-upload',
  cdata,
  loadTimeoutMs = 15000
}, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const isRenderedRef = useRef(false);
  const callbacksRef = useRef({ onSuccess, onError, onExpire });
  // Readiness poll, load timeout and deferred render, cleared on unmount.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const renderTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useImperativeHandle(ref, () => ({
    reset: () => {
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.reset(widgetIdRef.current);
        } catch (error) {
          console.error('Error resetting Turnstile widget:', error);
        }
      }
    }
  }), []);

  // Update callbacks ref when they change
  useEffect(() => {
    callbacksRef.current = { onSuccess, onError, onExpire };
  }, [onSuccess, onError, onExpire]);

  const handleSuccess = useCallback((token: string) => {
    setIsLoading(false);
    callbacksRef.current.onSuccess(token);
  }, []);

  const handleError = useCallback(() => {
    setIsLoading(false);
    callbacksRef.current.onError?.();
  }, []);

  const handleExpire = useCallback(() => {
    callbacksRef.current.onExpire?.();
  }, []);

  useEffect(() => {
    // Only render once, don't re-render on prop changes
    if (isRenderedRef.current) {
      return;
    }

    // Reset loading state on mount
    setIsLoading(true);

    const stopWaiting = () => {
      if (pollRef.current !== null) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      if (loadTimeoutRef.current !== null) {
        clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }
    };

    // The script or API never became available: stop waiting and report it,
    // instead of showing "Loading security check..." forever.
    const failLoad = (reason: string) => {
      stopWaiting();
      console.error(`Turnstile failed to load: ${reason}`);
      handleError();
    };

    // Poll for window.turnstile, giving up after loadTimeoutMs.
    const waitForTurnstile = () => {
      stopWaiting();
      pollRef.current = setInterval(() => {
        if (window.turnstile) {
          stopWaiting();
          renderWidget();
        }
      }, 100);
      loadTimeoutRef.current = setTimeout(() => failLoad('timed out'), loadTimeoutMs);
    };

    // Load Turnstile script
    const loadTurnstile = () => {
      if (document.querySelector(TURNSTILE_SCRIPT_SELECTOR)) {
        // Script already loaded
        if (window.turnstile) {
          // Use setTimeout to ensure DOM is ready after navigation
          renderTimeoutRef.current = setTimeout(() => {
            renderTimeoutRef.current = null;
            renderWidget();
          }, 100);
        } else {
          // Script exists but turnstile not ready yet
          waitForTurnstile();
        }
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;

      script.onerror = () => {
        // Drop the failed tag so a later mount (retry) loads the script again
        // instead of polling for an API that will never arrive.
        script.remove();
        failLoad('script error');
      };

      document.head.appendChild(script);
      // Covers both a slow script and one that loads without defining the API.
      waitForTurnstile();
    };

    const renderWidget = () => {
      // Don't render again if already rendered
      if (isRenderedRef.current) {
        return;
      }

      // Clean up any existing widget first
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
          widgetIdRef.current = null;
        } catch (error) {
          console.error('Error cleaning up existing widget:', error);
          widgetIdRef.current = null;
        }
      }

      if (!containerRef.current) return;

      try {
        const widgetConfig: TurnstileOptions = {
          sitekey: siteKey,
          'refresh-expired': 'auto',
          'refresh-timeout': 'auto',
          'retry': 'auto',
          'retry-interval': 8000,
          callback: handleSuccess,
          'error-callback': handleError,
          'expired-callback': handleExpire,
          'timeout-callback': handleError
        };

        // Add action and cdata if provided
        if (action) {
          widgetConfig.action = action;
        }
        if (cdata) {
          widgetConfig.cdata = cdata;
        }

        widgetIdRef.current = window.turnstile.render(containerRef.current, widgetConfig);
        isRenderedRef.current = true;
      } catch (error) {
        console.error('Failed to render Turnstile widget:', error);
        setIsLoading(false);
        handleError();
      }
    };

    loadTurnstile();

    // Cleanup
    return () => {
      stopWaiting();
      if (renderTimeoutRef.current !== null) {
        clearTimeout(renderTimeoutRef.current);
        renderTimeoutRef.current = null;
      }
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
          widgetIdRef.current = null;
          isRenderedRef.current = false;
        } catch (error) {
          console.error('Error removing Turnstile widget:', error);
        }
      }
    };
  }, [siteKey, action, loadTimeoutMs, handleSuccess, handleError, handleExpire]); // Only essential dependencies

  return (
    <div className="turnstile-container">
      <div ref={containerRef} className="cf-turnstile"></div>
      {isLoading && (
        <div className="turnstile-loading">
          <p>Loading security check...</p>
        </div>
      )}
    </div>
  );
}), (prevProps, nextProps) => {
  // Custom comparison - only re-render if siteKey or action changes
  return prevProps.siteKey === nextProps.siteKey &&
         prevProps.action === nextProps.action &&
         prevProps.loadTimeoutMs === nextProps.loadTimeoutMs;
});

CloudflareTurnstile.displayName = 'CloudflareTurnstile';

export default CloudflareTurnstile;