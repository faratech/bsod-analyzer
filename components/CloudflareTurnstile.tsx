import React, { useEffect, useRef, useState, useCallback, memo } from 'react';

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
}

const CloudflareTurnstile: React.FC<CloudflareTurnstileProps> = memo(({
  siteKey,
  onSuccess,
  onError,
  onExpire,
  action = 'file-upload',
  cdata
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const isRenderedRef = useRef(false);
  const callbacksRef = useRef({ onSuccess, onError, onExpire });

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

    // Load Turnstile script
    const loadTurnstile = () => {
      if (document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]')) {
        // Script already loaded
        if (window.turnstile) {
          // Use setTimeout to ensure DOM is ready after navigation
          setTimeout(() => renderWidget(), 100);
        } else {
          // Script exists but turnstile not ready yet
          const checkTurnstile = setInterval(() => {
            if (window.turnstile) {
              clearInterval(checkTurnstile);
              renderWidget();
            }
          }, 100);
        }
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;

      script.onload = () => {
        // Wait for turnstile to be available
        const checkTurnstile = setInterval(() => {
          if (window.turnstile) {
            clearInterval(checkTurnstile);
            renderWidget();
          }
        }, 100);
      };

      document.head.appendChild(script);
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
  }, [siteKey, action, handleSuccess, handleError, handleExpire]); // Only essential dependencies

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
}, (prevProps, nextProps) => {
  // Custom comparison - only re-render if siteKey or action changes
  return prevProps.siteKey === nextProps.siteKey &&
         prevProps.action === nextProps.action;
});

CloudflareTurnstile.displayName = 'CloudflareTurnstile';

export default CloudflareTurnstile;