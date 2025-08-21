# Configuration Guide

## Disabling/Enabling Ads

To control advertisements in the application, edit the `config.ts` file:

```typescript
// config.ts
export const config = {
    ads: {
        enabled: false,  // Change to true to enable ads
        publisherId: 'ca-pub-7455498979488414',
        autoAds: true
    },
    // ... other settings
};
```

### How it works:
- When `ads.enabled` is `false`, the AdSense script won't be loaded at all
- This prevents any ads from appearing anywhere in the application
- The setting is applied during the build process

### To enable ads:
1. Open `config.ts`
2. Change `ads.enabled` from `false` to `true`
3. Rebuild the application: `npm run build`
4. Deploy the updated build

## Other Configuration Options

### Analytics
Control Google Analytics tracking:
```typescript
analytics: {
    enabled: true,  // Set to false to disable analytics
    gtmId: 'GTM-PPFZ8NV2',
    gaId: 'G-0HVHB49RDP'
}
```

### API Settings
Configure Gemini API settings:
```typescript
api: {
    geminiModel: 'gemini-2.5-flash',
    maxFileSize: 100 * 1024 * 1024, // 100MB
    minidumpThreshold: 5 * 1024 * 1024 // 5MB
}
```

## Important Notes
- Configuration changes require rebuilding the application
- The config is embedded during build time for optimal performance
- No runtime API calls are made to check these settings
