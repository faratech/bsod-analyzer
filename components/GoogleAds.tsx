import React from 'react';
import { Adsense } from '@ctrl/react-adsense';

// Display ad component with proper configuration
export const DisplayAd: React.FC<{ slot: string; format?: string }> = ({ 
    slot, 
    format = 'auto' 
}) => {
    return (
        <div className="ad-container">
            <Adsense
                client="ca-pub-7455498979488414"
                slot={slot}
                style={{ display: 'block' }}
                format={format}
                responsive="true"
                layoutKey="-fb+5w+4e-db+86"
            />
        </div>
    );
};

// In-article ad component
export const InArticleAd: React.FC = () => {
    return (
        <div className="ad-container in-article">
            <Adsense
                client="ca-pub-7455498979488414"
                slot="1234567890" // Replace with your actual ad slot
                style={{ display: 'block', textAlign: 'center' }}
                layout="in-article"
                format="fluid"
            />
        </div>
    );
};

// Multiplex ad (matches content)
export const MultiplexAd: React.FC = () => {
    return (
        <div className="ad-container multiplex">
            <Adsense
                client="ca-pub-7455498979488414"
                slot="2345678901" // Replace with your actual ad slot
                style={{ display: 'block' }}
                format="autorelaxed"
            />
        </div>
    );
};

// Fixed banner ad
export const BannerAd: React.FC = () => {
    return (
        <div className="ad-container banner">
            <Adsense
                client="ca-pub-7455498979488414"
                slot="3456789012" // Replace with your actual ad slot
                style={{ display: 'inline-block', width: '728px', height: '90px' }}
                format=""
            />
        </div>
    );
};

// Responsive display ad
export const ResponsiveAd: React.FC = () => {
    return (
        <div className="ad-container responsive">
            <Adsense
                client="ca-pub-7455498979488414"
                slot="4567890123" // Replace with your actual ad slot
                style={{ display: 'block' }}
                format="auto"
                responsive="true"
                fullWidthResponsive="true"
            />
        </div>
    );
};