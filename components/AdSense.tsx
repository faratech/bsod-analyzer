import React from 'react';
import { Adsense } from '@ctrl/react-adsense';
import { ADSENSE_CONFIG, getAdSlot } from '../config/adsense';

interface AdProps {
  className?: string;
  style?: React.CSSProperties;
}

// Display Ad - Responsive format
export const DisplayAd: React.FC<AdProps> = ({ className = '', style = {} }) => (
  <div className={`ad-container ${className}`}>
    <Adsense
      client={ADSENSE_CONFIG.client}
      slot={getAdSlot('headerDisplay')}
      style={{ display: 'block', ...style }}
      format="auto"
      responsive="true"
      data-full-width-responsive="true"
    />
  </div>
);

// In-Feed Ad - Fluid in-article format
export const InFeedAd: React.FC<AdProps> = ({ className = '', style = {} }) => (
  <div className={`ad-container ${className}`}>
    <Adsense
      client={ADSENSE_CONFIG.client}
      slot={getAdSlot('inFeed')}
      style={{ display: 'block', textAlign: 'center', ...style }}
      layout="in-article"
      format="fluid"
    />
  </div>
);

// In-Article Ad - Fluid in-article format
export const InArticleAd: React.FC<AdProps> = ({ className = '', style = {} }) => (
  <div className={`ad-container ${className}`}>
    <Adsense
      client={ADSENSE_CONFIG.client}
      slot={getAdSlot('inArticle')}
      style={{ display: 'block', textAlign: 'center', ...style }}
      layout="in-article"
      format="fluid"
    />
  </div>
);

// Multiplex Ad - Content recommendations
export const MultiplexAd: React.FC<AdProps> = ({ className = '', style = {} }) => (
  <div className={`ad-container ${className}`}>
    <Adsense
      client={ADSENSE_CONFIG.client}
      slot={getAdSlot('multiplex')}
      style={{ display: 'block', ...style }}
      format="autorelaxed"
    />
  </div>
);

// Sticky Ad - For mobile sticky placement
export const StickyAd: React.FC<AdProps> = ({ className = '', style = {} }) => (
  <div className={`ad-container sticky-ad ${className}`}>
    <Adsense
      client={ADSENSE_CONFIG.client}
      slot={getAdSlot('mobileSticky')}
      style={{ display: 'block', ...style }}
      format="auto"
      responsive="true"
      data-full-width-responsive="true"
    />
  </div>
);

// Generic AdSense component for custom implementations
export const AdSense: React.FC<{
  slot: string;
  format?: string;
  layout?: string;
  className?: string;
  style?: React.CSSProperties;
  responsive?: string;
  fullWidthResponsive?: string;
}> = ({ 
  slot, 
  format = 'auto', 
  layout, 
  className = '', 
  style = {}, 
  responsive,
  fullWidthResponsive 
}) => (
  <div className={`ad-container ${className}`}>
    <Adsense
      client={ADSENSE_CONFIG.client}
      slot={slot}
      style={{ display: 'block', ...style }}
      format={format}
      layout={layout}
      responsive={responsive}
      data-full-width-responsive={fullWidthResponsive}
    />
  </div>
);

export default AdSense;