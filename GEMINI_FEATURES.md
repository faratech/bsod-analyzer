# Gemini 3.1 Flash Lite Enhanced Features

## Overview

This document describes the Gemini-powered analysis path for the BSOD Analyzer, including JSON report generation, server-side validation, and optimized parameters.

## Features

### 1. Gemini 3.1 Flash Lite Model

The BSOD analyzer now uses Gemini 3.1 Flash Lite, which includes:

**Current Configuration:**
```javascript
config: {
    temperature: 0.7,          // Balanced creativity and accuracy
    maxOutputTokens: 4096,     // Support for detailed analysis
}
```

**Benefits for BSOD Analysis:**
- Superior reasoning capabilities for complex crash patterns
- Better understanding of driver interactions and dependencies  
- More accurate root cause analysis
- Enhanced ability to trace through stack traces and identify culprits

**Note on Thinking Mode:**
According to Google's documentation, Gemini 3.1 Flash Lite comes with thinking capabilities enabled by default. The `thinkingConfig` parameter with `thinkingBudget` appears to be available in some contexts but may not be fully supported through all API endpoints yet.

### 2. Grounding Status

The standard BSOD analysis path uses JSON response mode with a server-owned
schema. Google Search grounding is not enabled for that path because grounding
cannot be combined with the JSON response contract used for validated reports.

Advanced text-only tools should not be documented as grounded unless a concrete
tool configuration is reintroduced and covered by tests.

### 3. Enhanced Configuration

The analyzer now includes:
- Temperature: 0.7 for balanced creativity and accuracy
- Max Output Tokens: 4096 for detailed analysis
- Server-owned response schema for normalized structured reports

## API Configuration

### Server Configuration (server.js)

The server owns model selection and generation constraints:
- Ignores client-supplied model names
- Restricts generation controls to bounded temperature and max output tokens
- Validates prompt shape before forwarding to Gemini
- Validates and normalizes JSON reports before returning them

### Client Configuration (geminiProxy.ts)

The client includes:
- WinDBG-output interpretation prompts
- Full local minidump fallback prompts
- Lightweight large-dump failover prompts using sampled head/tail bytes
- Session-aware Gemini proxy calls through the backend

## Cost Implications

Costs depend on the configured Gemini model in `model.cfg` and Google pricing.
The application also tracks per-session input/output token usage server-side
and enforces the configured quota before forwarding requests.

## Future Enhancements

1. **Grounded Text Tools**: Reintroduce grounding only for text-only advanced tools if the API configuration and tests support it
2. **Thought Summaries**: Add support for exposing model reasoning summaries if the selected model and policy allow it
3. **Dynamic Thinking Budget**: Allow server-controlled thinking budgets based on dump complexity if supported by the selected model

## Usage Notes

1. The standard BSOD analysis uses JSON mode with high reasoning but no grounding
2. WinDBG output is preferred when available because it provides full debugger context
3. If WinDBG is down, minidumps use full local evidence and large dumps use sampled AI failover
