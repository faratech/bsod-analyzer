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
Configure analysis API settings:
```typescript
api: {
    maxFileSize: 100 * 1024 * 1024, // 100MB
    minidumpThreshold: FILE_SIZE_THRESHOLDS.MINIDUMP
}
```

The AI model is controlled exclusively on the backend through `model.cfg`; no
model selector or provider credential is exposed to the browser.

The configured production choices are:

```text
gemini-3.1-flash-lite
deepseek-v4-flash
```

Gemini models use `GEMINI_API_KEY`. DeepSeek V4 Flash uses
`DEEPSEEK_API_KEY` and the official `https://api.deepseek.com` endpoint. To
select DeepSeek, put this exact value in `model.cfg`:

```text
deepseek-v4-flash
```

Optional DeepSeek backend settings:

| Variable | Default | Purpose |
|---|---|---|
| `DEEPSEEK_API_BASE_URL` | `https://api.deepseek.com` | Override the official API base URL |
| `DEEPSEEK_TIMEOUT_MS` | `GEMINI_TIMEOUT_MS` or 60 seconds | Request timeout |
| `DEEPSEEK_THINKING` | `enabled` | Set to `disabled`, `false`, or `0` for non-thinking mode |
| `DEEPSEEK_REASONING_EFFORT` | `high` | Set to `high` or `max` |

The server requests JSON output and applies the same local report validation
for both providers. Cached AI reports are isolated by model, while reusable
WinDBG evidence remains shared. Upload extension, size, and archive validation
rules are shared through `shared/ingestPolicy.js`.

## Important Notes
- Configuration changes require rebuilding the application
- The config is embedded during build time for optimal performance
- No runtime API calls are made to check these settings
