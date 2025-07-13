// AdSense Configuration
// IMPORTANT: Replace these placeholder IDs with your actual AdSense ad unit IDs
// 
// To get your ad unit IDs:
// 1. Log in to your AdSense account at https://www.google.com/adsense
// 2. Go to Ads > By ad unit
// 3. Create new ad units for each type (Display ads, In-feed ads, Multiplex ads)
// 4. Copy the data-ad-slot number from each ad unit code
// 5. Replace the placeholder numbers below with your actual ad unit IDs

export const ADSENSE_CONFIG = {
  client: 'ca-pub-7455498979488414',
  slots: {
    // Display ads (responsive)
    headerDisplay: '1234567890', // Replace with actual ad unit ID for header display ads
    inlineDisplay: '2345678901', // Replace with actual ad unit ID for inline display ads
    
    // In-feed/In-article ads
    inFeed: '3456789012', // Replace with actual ad unit ID for in-feed ads
    inArticle: '4567890123', // Replace with actual ad unit ID for in-article ads
    
    // Multiplex ads (content recommendations)
    multiplex: '5678901234', // Replace with actual ad unit ID for multiplex ads
    
    // Mobile ads
    mobileSticky: '6789012345', // Replace with actual ad unit ID for mobile sticky ads
    
    // AMP ads
    ampDisplay: '7890123456', // Replace with actual ad unit ID for AMP display ads
    ampSticky: '8901234567', // Replace with actual ad unit ID for AMP sticky ads
  }
};

// Helper to get ad slot by type
export const getAdSlot = (type: keyof typeof ADSENSE_CONFIG.slots): string => {
  return ADSENSE_CONFIG.slots[type];
};