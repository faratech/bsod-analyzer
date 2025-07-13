import React, { useEffect } from 'react';
import { ADSENSE_CONFIG, getAdSlot } from '../config/adsense';

declare global {
  interface Window {
    adsbygoogle: any[];
  }
}

interface AdSenseProps {
  client: string;
  slot: string;
  format?: 'auto' | 'fluid' | 'rectangle' | 'vertical' | 'horizontal';
  responsive?: boolean;
  fullWidthResponsive?: boolean;
  className?: string;
  style?: React.CSSProperties;
  layout?: string;
  layoutKey?: string;
}

const AdSense: React.FC<AdSenseProps> = ({
  client,
  slot,
  format = 'auto',
  responsive = true,
  fullWidthResponsive = true,
  className = '',
  style = {},
  layout,
  layoutKey,
}) => {
  useEffect(() => {
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch (err) {
      console.error('AdSense error:', err);
    }
  }, []);

  return (
    <div className={`ad-container ${className}`}>
      <ins
        className="adsbygoogle"
        style={{
          display: 'block',
          ...style,
        }}
        data-ad-client={client}
        data-ad-slot={slot}
        data-ad-format={format}
        data-full-width-responsive={fullWidthResponsive ? 'true' : 'false'}
        {...(responsive && { 'data-ad-responsive': 'true' })}
        {...(layout && { 'data-ad-layout': layout })}
        {...(layoutKey && { 'data-ad-layout-key': layoutKey })}
      />
    </div>
  );
};

// Specific ad type components for easier usage
export const DisplayAd: React.FC<Partial<AdSenseProps>> = (props) => (
  <AdSense
    client={ADSENSE_CONFIG.client}
    slot={props.slot || getAdSlot('headerDisplay')}
    format="auto"
    responsive={true}
    {...props}
  />
);

export const InFeedAd: React.FC<Partial<AdSenseProps>> = (props) => (
  <AdSense
    client={ADSENSE_CONFIG.client}
    slot={props.slot || getAdSlot('inFeed')}
    format="fluid"
    layout="in-article"
    {...props}
  />
);

export const InArticleAd: React.FC<Partial<AdSenseProps>> = (props) => (
  <AdSense
    client={ADSENSE_CONFIG.client}
    slot={props.slot || getAdSlot('inArticle')}
    format="fluid"
    layout="in-article"
    style={{ textAlign: 'center' }}
    {...props}
  />
);

export const MultiplexAd: React.FC<Partial<AdSenseProps>> = (props) => (
  <AdSense
    client={ADSENSE_CONFIG.client}
    slot={props.slot || getAdSlot('multiplex')}
    format="autorelaxed"
    {...props}
  />
);

export const StickyAd: React.FC<Partial<AdSenseProps>> = (props) => (
  <AdSense
    client={ADSENSE_CONFIG.client}
    slot={props.slot || getAdSlot('mobileSticky')}
    format="auto"
    className="sticky-ad"
    {...props}
  />
);

export default AdSense;