import React, { useEffect } from 'react';

declare global {
    interface Window {
        adsbygoogle: any[];
    }
}

interface AdSenseProps {
    adSlot: string;
    adFormat?: 'auto' | 'fluid' | 'rectangle' | 'vertical' | 'horizontal';
    fullWidthResponsive?: boolean;
    style?: React.CSSProperties;
    className?: string;
}

const AdSense: React.FC<AdSenseProps> = ({
    adSlot,
    adFormat = 'auto',
    fullWidthResponsive = true,
    style = {},
    className = ''
}) => {
    useEffect(() => {
        try {
            if (typeof window !== 'undefined') {
                (window.adsbygoogle = window.adsbygoogle || []).push({});
            }
        } catch (error) {
            console.error('AdSense error:', error);
        }
    }, []);

    return (
        <div className={`adsense-container ${className}`} style={{ textAlign: 'center', margin: '2rem 0', ...style }}>
            <ins
                className="adsbygoogle"
                style={{ display: 'block', ...style }}
                data-ad-client="ca-pub-7455498979488414"
                data-ad-slot={adSlot}
                data-ad-format={adFormat}
                data-full-width-responsive={fullWidthResponsive.toString()}
            />
        </div>
    );
};

// Pre-configured ad components for different placements
export const HeaderAd: React.FC = () => (
    <AdSense 
        adSlot="1234567890" 
        adFormat="horizontal"
        style={{ maxHeight: '90px' }}
        className="header-ad"
    />
);

export const SidebarAd: React.FC = () => (
    <AdSense 
        adSlot="2345678901" 
        adFormat="vertical"
        className="sidebar-ad"
    />
);

export const InContentAd: React.FC = () => (
    <AdSense 
        adSlot="3456789012" 
        adFormat="auto"
        className="in-content-ad"
    />
);

export const FooterAd: React.FC = () => (
    <AdSense 
        adSlot="4567890123" 
        adFormat="horizontal"
        style={{ maxHeight: '100px' }}
        className="footer-ad"
    />
);

export default AdSense;