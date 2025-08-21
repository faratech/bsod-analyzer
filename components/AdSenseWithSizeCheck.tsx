import React, { useEffect, useRef, useState } from 'react';
import { ADSENSE_CONFIG, getAdSlot } from '../config/adsense';

// Declare global adsbygoogle
declare global {
  interface Window {
    adsbygoogle: unknown[];
  }
}

interface AdProps {
  className?: string;
  style?: React.CSSProperties;
  minWidth?: number; // Minimum width required to show ad
}

// Hook to check if element has sufficient width
const useElementWidth = (ref: React.RefObject<HTMLElement>, minWidth: number = 100) => {
  const [hasWidth, setHasWidth] = useState(false);
  
  useEffect(() => {
    const checkWidth = () => {
      if (ref.current) {
        const width = ref.current.offsetWidth;
        console.log(`[AdSense] Container width: ${width}px`);
        setHasWidth(width >= minWidth);
      }
    };
    
    // Check immediately
    checkWidth();
    
    // Check on resize
    const resizeObserver = new ResizeObserver(checkWidth);
    if (ref.current) {
      resizeObserver.observe(ref.current);
    }
    
    // Also check after a delay for dynamic content
    const timer = setTimeout(checkWidth, 1000);
    
    return () => {
      resizeObserver.disconnect();
      clearTimeout(timer);
    };
  }, [ref, minWidth]);
  
  return hasWidth;
};

// Enhanced Display Ad with size checking
export const DisplayAdSafe: React.FC<AdProps> = ({ 
  className = '', 
  style = {}, 
  minWidth = 200 
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const hasWidth = useElementWidth(containerRef, minWidth);
  const [adPushed, setAdPushed] = useState(false);
  
  useEffect(() => {
    if (hasWidth && !adPushed) {
      console.log('[AdSense] Container has sufficient width, pushing ad');
      try {
        (window.adsbygoogle = window.adsbygoogle || []).push({});
        setAdPushed(true);
      } catch (err) {
        console.error('[AdSense] Error pushing ad:', err);
        // Check if it's the "No slot size" error
        if (err && err.message && err.message.includes('No slot size')) {
          console.log('[AdSense] Retrying after delay due to slot size error');
          setTimeout(() => {
            try {
              (window.adsbygoogle = window.adsbygoogle || []).push({});
              setAdPushed(true);
            } catch (retryErr) {
              console.error('[AdSense] Retry failed:', retryErr);
            }
          }, 2000);
        }
      }
    }
  }, [hasWidth, adPushed]);
  
  return (
    <div ref={containerRef} className={`ad-container ${className}`}>
      {hasWidth ? (
        <ins
          className="adsbygoogle"
          style={{ display: 'block', minHeight: '90px', ...style }}
          data-ad-client={ADSENSE_CONFIG.client}
          data-ad-slot={getAdSlot('headerDisplay')}
          data-ad-format="auto"
          data-full-width-responsive="true"
        />
      ) : (
        <div style={{ minHeight: '90px', display: 'none' }} />
      )}
    </div>
  );
};

// Safe wrapper for any ad component
export const AdWrapper: React.FC<{
  children: React.ReactNode;
  minWidth?: number;
  fallback?: React.ReactNode;
}> = ({ children, minWidth = 200, fallback = null }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const hasWidth = useElementWidth(containerRef, minWidth);
  
  return (
    <div ref={containerRef}>
      {hasWidth ? children : fallback}
    </div>
  );
};

// Error boundary for ads
export class AdErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback?: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false };
  }
  
  static getDerivedStateFromError(error: Error) {
    console.error('[AdSense] Error boundary caught:', error);
    return { hasError: true };
  }
  
  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[AdSense] Error details:', error, errorInfo);
  }
  
  render() {
    if (this.state.hasError) {
      return this.props.fallback || null;
    }
    
    return this.props.children;
  }
}

// Enhanced ad component with all safety checks
export const SafeAd: React.FC<{
  type: 'display' | 'infeed' | 'inarticle' | 'multiplex';
  className?: string;
  style?: React.CSSProperties;
  minWidth?: number;
}> = ({ type, className = '', style = {}, minWidth = 200 }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const hasWidth = useElementWidth(containerRef, minWidth);
  const [isVisible, setIsVisible] = useState(false);
  
  // Check if element is visible in viewport
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsVisible(entry.isIntersecting);
      },
      { threshold: 0.1 }
    );
    
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    
    return () => observer.disconnect();
  }, []);
  
  // Only push ad when visible and has width
  useEffect(() => {
    if (hasWidth && isVisible) {
      console.log(`[AdSense] Pushing ${type} ad - visible and has width`);
      try {
        (window.adsbygoogle = window.adsbygoogle || []).push({});
      } catch (err) {
        console.error(`[AdSense] Error pushing ${type} ad:`, err);
      }
    }
  }, [hasWidth, isVisible, type]);
  
  const getAdProps = () => {
    switch (type) {
      case 'display':
        return {
          slot: getAdSlot('headerDisplay'),
          format: 'auto',
          responsive: 'true'
        };
      case 'infeed':
        return {
          slot: getAdSlot('inFeed'),
          format: 'fluid',
          layout: 'in-article'
        };
      case 'inarticle':
        return {
          slot: getAdSlot('inArticle'),
          format: 'fluid',
          layout: 'in-article'
        };
      case 'multiplex':
        return {
          slot: getAdSlot('multiplex'),
          format: 'autorelaxed'
        };
      default:
        return {
          slot: getAdSlot('headerDisplay'),
          format: 'auto',
          responsive: 'true'
        };
    }
  };
  
  const adProps = getAdProps();
  
  return (
    <div ref={containerRef} className={`ad-container ${className}`}>
      {hasWidth && isVisible ? (
        <ins
          className="adsbygoogle"
          style={{ display: 'block', minHeight: '90px', ...style }}
          data-ad-client={ADSENSE_CONFIG.client}
          data-ad-slot={adProps.slot}
          data-ad-format={adProps.format}
          data-ad-layout={adProps.layout}
          data-full-width-responsive={adProps.responsive}
        />
      ) : null}
    </div>
  );
};