import React, { useEffect, useRef, useState } from 'react';

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

const CloudflareTurnstile: React.FC<CloudflareTurnstileProps> = ({
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

  useEffect(() => {
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
          callback: (token: string) => {
            setIsLoading(false);
            onSuccess(token);
          },
          'error-callback': () => {
            setIsLoading(false);
            onError?.();
          },
          'expired-callback': () => {
            onExpire?.();
          },
          'timeout-callback': () => {
            setIsLoading(false);
            onError?.();
          }
        };
        
        // Add action and cdata if provided
        if (action) {
          widgetConfig.action = action;
        }
        if (cdata) {
          widgetConfig.cdata = cdata;
        }
        
        widgetIdRef.current = window.turnstile.render(containerRef.current, widgetConfig);
      } catch (error) {
        console.error('Failed to render Turnstile widget:', error);
        setIsLoading(false);
        onError?.();
      }
    };

    loadTurnstile();

    // Cleanup
    return () => {
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
          widgetIdRef.current = null;
        } catch (error) {
          console.error('Error removing Turnstile widget:', error);
        }
      }
    };
  }, [siteKey, onSuccess, onError, onExpire, action, cdata]);

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
};

export default CloudflareTurnstile;