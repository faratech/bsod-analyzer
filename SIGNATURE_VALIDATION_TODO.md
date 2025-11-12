# HMAC Signature Validation - Implementation Issues & TODO

## Current Status: DISABLED

Signature validation is currently **disabled** (see `SIGNATURE_VALIDATION_ENABLED = false` in server.js:1027).

## Problem

Client and server generate different HMAC signatures for the same request, causing all requests to be rejected with "Invalid request signature" error.

### Root Cause

JSON.stringify() does not guarantee consistent key ordering between JavaScript environments. This means:

**Client generates:**
```javascript
const payload = JSON.stringify(contents) + timestamp;
// Example: {"parts":[{"text":"..."}],"role":"user"}1731376800000
```

**Server expects:**
```javascript
const payload = JSON.stringify(req.body.contents) + timestamp;
// Example: {"role":"user","parts":[{"text":"..."}]}1731376800000
```

Even though these represent the same object, different key ordering produces different HMAC signatures.

### Evidence from Logs

```
[Debug] Expected signature: bf67203fae8dec50a93cf6658f927c1760196f71f0cfc5940fb5449cbd42171c
[Debug] Received signature: f2cdcba36cea0e59be554e0d6705b2c7f0c74a24814b2d03616d2e5bd0de9bb7
[Debug] Signatures match: false
```

## Solutions

### Option 1: Canonical JSON (Recommended)

Use deterministic JSON serialization that guarantees key ordering:

```typescript
// Install: npm install fast-json-stable-stringify
import stringify from 'fast-json-stable-stringify';

// Client (geminiProxy.ts)
const payload = stringify(contents) + timestamp;

// Server (server.js)
const payload = stringify(req.body.contents) + timestamp;
```

### Option 2: Sign Metadata Only

Don't sign the large contents object, sign only metadata:

```typescript
// Client
const payload = `${sessionId}|${timestamp}|${contents.length}`;

// Server
const payload = `${sessionId}|${timestamp}|${req.body.contents.length}`;
```

### Option 3: Use Nonce Instead

Replace HMAC with simpler nonce-based validation:

```typescript
// Client
const nonce = crypto.randomBytes(16).toString('hex');
localStorage.setItem('lastNonce', nonce);

// Server
const expectedNonce = session.nonce;
session.nonce = crypto.randomBytes(16).toString('hex');
```

## Current Security Measures (Still Active)

Even with signature validation disabled, the API has strong protection:

1. **Session Validation** - All requests require valid session cookie
2. **Rate Limiting** - 10 requests per hour per session
3. **Token Quota** - 100K tokens per hour per session
4. **Prompt Validation** - Blocks non-BSOD content and abuse patterns
5. **CSRF Protection** - Session cookies with SameSite=Strict
6. **Cloudflare Turnstile** - Bot protection on session creation

## Implementation Steps

1. Choose solution (recommend Option 1)
2. Install dependencies: `npm install fast-json-stable-stringify`
3. Update client: `/bsod-analyzer/services/geminiProxy.ts:77`
4. Update server: `/bsod-analyzer/server.js:849`
5. Test locally with real dump file
6. Enable validation: Set `SIGNATURE_VALIDATION_ENABLED = true`
7. Deploy and monitor logs
8. Remove debug logging once verified

## Priority

**Medium** - The app is secure without this feature, but it would add defense-in-depth.

## Testing Checklist

- [ ] Generate signature on client
- [ ] Verify signature matches on server
- [ ] Test with various content sizes
- [ ] Test with special characters in content
- [ ] Verify timestamp expiry works (5 min window)
- [ ] Test signature rejection for tampered requests
- [ ] Monitor production logs for failures

## Timeline

Should be implemented before marketing launch, but not blocking for current beta usage.
