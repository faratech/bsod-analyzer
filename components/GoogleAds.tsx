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