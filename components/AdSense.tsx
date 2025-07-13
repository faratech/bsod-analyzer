import React, { useEffect } from 'react';

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
        data-full-width-responsive={fullWidthResponsive}
        {...(layout && { 'data-ad-layout': layout })}
        {...(layoutKey && { 'data-ad-layout-key': layoutKey })}
      />
    </div>
  );
};

// Specific ad type components for easier usage
export const DisplayAd: React.FC<Partial<AdSenseProps>> = (props) => (
  <AdSense
    client="ca-pub-7455498979488414"
    format="auto"
    responsive={true}
    {...props}
  />
);

export const InFeedAd: React.FC<Partial<AdSenseProps>> = (props) => (
  <AdSense
    client="ca-pub-7455498979488414"
    format="fluid"
    layout="in-article"
    {...props}
  />
);

export const InArticleAd: React.FC<Partial<AdSenseProps>> = (props) => (
  <AdSense
    client="ca-pub-7455498979488414"
    format="fluid"
    layout="in-article"
    style={{ textAlign: 'center' }}
    {...props}
  />
);

export const MultiplexAd: React.FC<Partial<AdSenseProps>> = (props) => (
  <AdSense
    client="ca-pub-7455498979488414"
    format="autorelaxed"
    {...props}
  />
);

export const StickyAd: React.FC<Partial<AdSenseProps>> = (props) => (
  <AdSense
    client="ca-pub-7455498979488414"
    format="auto"
    className="sticky-ad"
    {...props}
  />
);

export default AdSense;