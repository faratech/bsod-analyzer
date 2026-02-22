import React, { useEffect, useRef, useState } from 'react';
import { ADSENSE_CONFIG, getAdSlot } from '../config/adsense';

interface AdProps {
  className?: string;
  style?: React.CSSProperties;
  minWidth?: number;
}

// Hook to check if element has sufficient width using ResizeObserver
// (avoids forced reflows from reading offsetWidth synchronously)
const useElementWidth = (ref: React.RefObject<HTMLElement | null>, minWidth: number = 100) => {
  const [hasWidth, setHasWidth] = useState(false);

  useEffect(() => {
    if (!ref.current) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
        setHasWidth(width >= minWidth);
      }
    });

    resizeObserver.observe(ref.current);

    return () => {
      resizeObserver.disconnect();
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
      try {
        (window.adsbygoogle = window.adsbygoogle || []).push({});
        setAdPushed(true);
      } catch (err) {
        // Retry once after delay for "No slot size" errors
        if (err instanceof Error && err.message.includes('No slot size')) {
          setTimeout(() => {
            try {
              (window.adsbygoogle = window.adsbygoogle || []).push({});
              setAdPushed(true);
            } catch (_) {
              // Ad failed to load, silently ignore
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
      try {
        (window.adsbygoogle = window.adsbygoogle || []).push({});
      } catch (_) {
        // Ad failed to load, silently ignore
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