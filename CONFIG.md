# Configuration Guide

## Disabling/Enabling Ads

To control advertisements in the application, edit the `config.ts` file:

```typescript
// config.ts
export const config = {
    ads: {
        enabled: true,  // Change to false to disable ads
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
2. Change `ads.enabled` to `true`
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
    maxFileSize: 100 * 1024 * 1024, // 100MB
    minidumpThreshold: FILE_SIZE_THRESHOLDS.MINIDUMP
}
```

The Gemini model is controlled server-side through `model.cfg`, not through
client configuration. Upload extension, size, and archive validation rules are
shared through `shared/ingestPolicy.js`.

## Important Notes
- Configuration changes require rebuilding the application
- The config is embedded during build time for optimal performance
- No runtime API calls are made to check these settings
