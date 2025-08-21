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
    headerDisplay: '6778196821', // WindowsForum Responsive
    inlineDisplay: '6778196821', // WindowsForum Responsive (can reuse for multiple placements)
    squareResponsive: '5987799550', // Square Responsive
    horizontalResponsive: '2048554545', // Horizontal Responsive
    verticalResponsive: '8366550888', // Vertical Responsive
    
    // In-feed/In-article ads
    inFeed: '5939698092', // In-article format
    inArticle: '5939698092', // In-article format
    
    // Multiplex ads (content recommendations)
    multiplex: '5526116193', // Autorelaxed format
    verticalMultiplex: '1275879997', // Vertical Responsive Multiplex
    
    // Mobile ads
    mobileSticky: '6778196821', // WindowsForum Responsive (works for sticky too)
    
    // AMP ads
    ampDisplay: '6778196821', // WindowsForum Responsive
    ampSticky: '6778196821', // WindowsForum Responsive
    ampSquare: '5987799550', // Square Responsive for AMP
    ampHorizontal: '2048554545', // Horizontal Responsive for AMP
    ampVertical: '8366550888', // Vertical Responsive for AMP
    ampMultiplex: '1275879997', // Vertical Multiplex for AMP
  }
};

// Helper to get ad slot by type
export const getAdSlot = (type: keyof typeof ADSENSE_CONFIG.slots): string => {
  return ADSENSE_CONFIG.slots[type];
};