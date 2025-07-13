// Application Configuration
export const config = {
    // Advertisement Settings
    ads: {
        enabled: false,  // Set to true to enable ads
        publisherId: 'ca-pub-7455498979488414',
        autoAds: true   // Enable/disable auto ads
    },
    
    // Analytics Settings
    analytics: {
        enabled: true,
        gtmId: 'GTM-PPFZ8NV2',
        gaId: 'G-0HVHB49RDP'
    },
    
    // API Settings
    api: {
        geminiModel: 'gemini-2.0-flash-exp',
        maxFileSize: 100 * 1024 * 1024, // 100MB
        minidumpThreshold: 5 * 1024 * 1024 // 5MB
    }
};