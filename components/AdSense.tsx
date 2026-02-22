import React, { useEffect } from 'react';
import { ADSENSE_CONFIG, getAdSlot } from '../config/adsense';

declare global {
  interface Window {
    adsbygoogle: unknown[];
  }
}

interface AdProps {
  slot?: string;
  slotType?: keyof typeof ADSENSE_CONFIG.slots;
  format?: string;
  layout?: string;
  className?: string;
  style?: React.CSSProperties;
  responsive?: string;
}

const Ad: React.FC<AdProps> = ({
  slot,
  slotType,
  format = 'auto',
  layout,
  className = '',
  style = {},
  responsive = 'true',
}) => {
  const adSlot = slot ?? (slotType ? getAdSlot(slotType) : '');

  useEffect(() => {
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch (_) {
      /* silently ignore */
    }
  }, []);

  return (
    <div className={`ad-container ${className}`}>
      <ins
        className="adsbygoogle"
        style={{ display: 'block', ...style }}
        data-ad-client={ADSENSE_CONFIG.client}
        data-ad-slot={adSlot}
        data-ad-format={format}
        data-ad-layout={layout}
        data-full-width-responsive={responsive}
      />
    </div>
  );
};

export const DisplayAd: React.FC<AdProps> = (p) => <Ad slotType="headerDisplay" {...p} />;
export const InFeedAd: React.FC<AdProps> = (p) => <Ad slotType="inFeed" format="fluid" layout="in-article" responsive={undefined} {...p} />;
export const InArticleAd: React.FC<AdProps> = (p) => <Ad slotType="inArticle" format="fluid" layout="in-article" responsive={undefined} {...p} />;
export const MultiplexAd: React.FC<AdProps> = (p) => <Ad slotType="multiplex" format="autorelaxed" responsive={undefined} {...p} />;
export const StickyAd: React.FC<AdProps> = ({ className = '', ...rest }) => <Ad slotType="mobileSticky" className={`sticky-ad ${className}`} {...rest} />;
export const SquareAd: React.FC<AdProps> = (p) => <Ad slotType="squareResponsive" {...p} />;
export const HorizontalAd: React.FC<AdProps> = (p) => <Ad slotType="horizontalResponsive" {...p} />;
export const VerticalAd: React.FC<AdProps> = (p) => <Ad slotType="verticalResponsive" {...p} />;
export const VerticalMultiplexAd: React.FC<AdProps> = (p) => <Ad slotType="verticalMultiplex" format="autorelaxed" responsive={undefined} {...p} />;

export { Ad as AdSense };
export default Ad;
