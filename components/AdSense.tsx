import React, { useEffect, useState } from 'react';
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
}

// Hook to check AdSense initialization
const useAdSenseInit = () => {
  const [isLoaded, setIsLoaded] = useState(false);
  
  useEffect(() => {
    const checkAdSense = () => {
      if (window.adsbygoogle) {
        console.log('AdSense script loaded, adsbygoogle available');
        setIsLoaded(true);
      } else {
        console.log('Waiting for AdSense script...');
      }
    };
    
    // Check immediately
    checkAdSense();
    
    // Check again after a delay
    const timer = setTimeout(checkAdSense, 2000);
    
    return () => clearTimeout(timer);
  }, []);
  
  return isLoaded;
};

// Display Ad - Responsive format
export const DisplayAd: React.FC<AdProps> = ({ className = '', style = {} }) => {
  const isAdSenseLoaded = useAdSenseInit();
  
  useEffect(() => {
    console.log('DisplayAd rendering with:', {
      slot: getAdSlot('headerDisplay'),
      client: ADSENSE_CONFIG.client,
      isAdSenseLoaded
    });
    
    // Manually push the ad
    if (isAdSenseLoaded) {
      try {
        (window.adsbygoogle = window.adsbygoogle || []).push({});
        console.log('Pushed DisplayAd to adsbygoogle');
      } catch (err) {
        console.error('Error pushing ad:', err);
      }
    }
  }, [isAdSenseLoaded]);
  
  return (
    <div className={`ad-container ${className}`}>
      <ins
        className="adsbygoogle"
        style={{ display: 'block', ...style }}
        data-ad-client={ADSENSE_CONFIG.client}
        data-ad-slot={getAdSlot('headerDisplay')}
        data-ad-format="auto"
        data-full-width-responsive="true"
      />
    </div>
  );
};

// In-Feed Ad - Fluid in-article format
export const InFeedAd: React.FC<AdProps> = ({ className = '', style = {} }) => {
  useEffect(() => {
    console.log('InFeedAd rendering with slot:', getAdSlot('inFeed'));
    
    // Manually push the ad
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
      console.log('Pushed InFeedAd to adsbygoogle');
    } catch (err) {
      console.error('Error pushing ad:', err);
    }
  }, []);
  
  return (
    <div className={`ad-container ${className}`}>
      <ins
        className="adsbygoogle"
        style={{ display: 'block', textAlign: 'center', ...style }}
        data-ad-client={ADSENSE_CONFIG.client}
        data-ad-slot={getAdSlot('inFeed')}
        data-ad-layout="in-article"
        data-ad-format="fluid"
      />
    </div>
  );
};

// In-Article Ad - Fluid in-article format
export const InArticleAd: React.FC<AdProps> = ({ className = '', style = {} }) => {
  useEffect(() => {
    console.log('InArticleAd rendering with slot:', getAdSlot('inArticle'));
    
    // Manually push the ad
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
      console.log('Pushed InArticleAd to adsbygoogle');
    } catch (err) {
      console.error('Error pushing ad:', err);
    }
  }, []);
  
  return (
    <div className={`ad-container ${className}`}>
      <ins
        className="adsbygoogle"
        style={{ display: 'block', textAlign: 'center', ...style }}
        data-ad-client={ADSENSE_CONFIG.client}
        data-ad-slot={getAdSlot('inArticle')}
        data-ad-layout="in-article"
        data-ad-format="fluid"
      />
    </div>
  );
};

// Multiplex Ad - Content recommendations
export const MultiplexAd: React.FC<AdProps> = ({ className = '', style = {} }) => {
  useEffect(() => {
    console.log('MultiplexAd rendering with slot:', getAdSlot('multiplex'));
    
    // Manually push the ad
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
      console.log('Pushed MultiplexAd to adsbygoogle');
    } catch (err) {
      console.error('Error pushing ad:', err);
    }
  }, []);
  
  return (
    <div className={`ad-container ${className}`}>
      <ins
        className="adsbygoogle"
        style={{ display: 'block', ...style }}
        data-ad-client={ADSENSE_CONFIG.client}
        data-ad-slot={getAdSlot('multiplex')}
        data-ad-format="autorelaxed"
      />
    </div>
  );
};

// Sticky Ad - For mobile sticky placement
export const StickyAd: React.FC<AdProps> = ({ className = '', style = {} }) => {
  useEffect(() => {
    console.log('StickyAd rendering with slot:', getAdSlot('mobileSticky'));
    
    // Manually push the ad
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
      console.log('Pushed StickyAd to adsbygoogle');
    } catch (err) {
      console.error('Error pushing ad:', err);
    }
  }, []);
  
  return (
    <div className={`ad-container sticky-ad ${className}`}>
      <ins
        className="adsbygoogle"
        style={{ display: 'block', ...style }}
        data-ad-client={ADSENSE_CONFIG.client}
        data-ad-slot={getAdSlot('mobileSticky')}
        data-ad-format="auto"
        data-full-width-responsive="true"
      />
    </div>
  );
};

// Square Responsive Ad
export const SquareAd: React.FC<AdProps> = ({ className = '', style = {} }) => {
  useEffect(() => {
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch (err) {
      console.error('Error pushing square ad:', err);
    }
  }, []);
  
  return (
    <div className={`ad-container ${className}`}>
      <ins
        className="adsbygoogle"
        style={{ display: 'block', ...style }}
        data-ad-client={ADSENSE_CONFIG.client}
        data-ad-slot={getAdSlot('squareResponsive')}
        data-ad-format="auto"
        data-full-width-responsive="true"
      />
    </div>
  );
};

// Horizontal Responsive Ad
export const HorizontalAd: React.FC<AdProps> = ({ className = '', style = {} }) => {
  useEffect(() => {
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch (err) {
      console.error('Error pushing horizontal ad:', err);
    }
  }, []);
  
  return (
    <div className={`ad-container ${className}`}>
      <ins
        className="adsbygoogle"
        style={{ display: 'block', ...style }}
        data-ad-client={ADSENSE_CONFIG.client}
        data-ad-slot={getAdSlot('horizontalResponsive')}
        data-ad-format="auto"
        data-full-width-responsive="true"
      />
    </div>
  );
};

// Vertical Responsive Ad
export const VerticalAd: React.FC<AdProps> = ({ className = '', style = {} }) => {
  useEffect(() => {
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch (err) {
      console.error('Error pushing vertical ad:', err);
    }
  }, []);
  
  return (
    <div className={`ad-container ${className}`}>
      <ins
        className="adsbygoogle"
        style={{ display: 'block', ...style }}
        data-ad-client={ADSENSE_CONFIG.client}
        data-ad-slot={getAdSlot('verticalResponsive')}
        data-ad-format="auto"
        data-full-width-responsive="true"
      />
    </div>
  );
};

// Vertical Multiplex Ad - For content recommendations
export const VerticalMultiplexAd: React.FC<AdProps> = ({ className = '', style = {} }) => {
  useEffect(() => {
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch (err) {
      console.error('Error pushing vertical multiplex ad:', err);
    }
  }, []);
  
  return (
    <div className={`ad-container ${className}`}>
      <ins
        className="adsbygoogle"
        style={{ display: 'block', ...style }}
        data-ad-client={ADSENSE_CONFIG.client}
        data-ad-slot={getAdSlot('verticalMultiplex')}
        data-ad-format="autorelaxed"
      />
    </div>
  );
};

// Generic AdSense component for custom implementations
export const AdSense: React.FC<{
  slot: string;
  format?: string;
  layout?: string;
  layoutKey?: string;
  className?: string;
  style?: React.CSSProperties;
  responsive?: string;
  adTest?: string;
}> = ({ 
  slot, 
  format = 'auto', 
  layout,
  layoutKey,
  className = '', 
  style = {}, 
  responsive = 'true',
  adTest
}) => {
  useEffect(() => {
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch (err) {
      console.error('Error pushing ad:', err);
    }
  }, []);
  
  return (
    <div className={`ad-container ${className}`}>
      <ins
        className="adsbygoogle"
        style={{ display: 'block', ...style }}
        data-ad-client={ADSENSE_CONFIG.client}
        data-ad-slot={slot}
        data-ad-format={format}
        data-ad-layout={layout}
        data-ad-layout-key={layoutKey}
        data-full-width-responsive={responsive}
        data-adtest={adTest}
      />
    </div>
  );
};

export default AdSense;