export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';
export const DEEPSEEK_V4_FLASH_MODEL = 'deepseek-v4-flash';
export const DEFAULT_DEEPSEEK_API_BASE_URL = 'https://api.deepseek.com';

const TRANSIENT_DEEPSEEK_STATUSES = new Set([429, 500, 503]);

export class AIProviderError extends Error {
  constructor(message, { code = 'AI_PROVIDER_ERROR', status = 502, retryable = false } = {}) {
    super(message);
    this.name = 'AIProviderError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export function getAIProviderForModel(model) {
  const normalized = typeof model === 'string' ? model.trim() : '';
  if (normalized === DEEPSEEK_V4_FLASH_MODEL) return 'deepseek';
  if (/^gemini-[a-z0-9][a-z0-9.-]*$/i.test(normalized)) return 'gemini';
  return null;
}

export function isSupportedAIModel(model) {
  return getAIProviderForModel(model) !== null;
}

export function getCachedAIReportForModel(cached, model) {
  if (!cached || typeof cached !== 'object') return null;

  if (cached.aiReports && typeof cached.aiReports === 'object' && cached.aiReports[model]) {
    return cached.aiReports[model];
  }

  if (cached.aiModel === model && cached.aiReport) {
    return cached.aiReport;
  }

  // Cache entries written before model-aware caching were produced by the
  // repository's long-standing default model.
  if (!cached.aiModel && model === DEFAULT_GEMINI_MODEL && cached.aiReport) {
    return cached.aiReport;
  }

  return null;
}

export function normalizeDeepSeekApiBaseUrl(value = DEFAULT_DEEPSEEK_API_BASE_URL) {
  let candidate = String(value || DEFAULT_DEEPSEEK_API_BASE_URL).trim();
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;

  const parsed = new URL(candidate);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new AIProviderError('DeepSeek API URL must use HTTP or HTTPS', {
      code: 'DEEPSEEK_INVALID_BASE_URL',
      status: 500
    });
  }
  const isLocalhost = parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '::1';
  if (parsed.protocol !== 'https:' && !isLocalhost) {
    throw new AIProviderError('DeepSeek API URL must use HTTPS outside localhost', {
      code: 'DEEPSEEK_INVALID_BASE_URL',
      status: 500
    });
  }

  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

function deepSeekChatCompletionsUrl(baseUrl) {
  const normalized = normalizeDeepSeekApiBaseUrl(baseUrl);
  return normalized.endsWith('/chat/completions')
    ? normalized
    : `${normalized}/chat/completions`;
}

function safeInteger(value) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
}

async function readDeepSeekError(response) {
  let body = '';
  try {
    body = await response.text();
  } catch {
    return `DeepSeek request failed with HTTP ${response.status}`;
  }

  try {
    const parsed = JSON.parse(body);
    const message = parsed?.error?.message || parsed?.message;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 500);
  } catch {
    // Fall back to a bounded plain-text message below.
  }

  const bounded = body.trim().replace(/\s+/g, ' ').slice(0, 500);
  return bounded || `DeepSeek request failed with HTTP ${response.status}`;
}

function retryDelayMs(response, attempt) {
  const retryAfter = Number.parseFloat(response.headers?.get?.('retry-after') || '');
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(retryAfter * 1000, 2_000);
  }
  return Math.min(250 * (2 ** attempt), 2_000);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function generateDeepSeekContent(request, {
  apiKey,
  baseUrl = DEFAULT_DEEPSEEK_API_BASE_URL,
  fetchImpl = globalThis.fetch,
  maxRetries = 2,
  reasoningEffort = 'high',
  thinkingEnabled = true,
  signal,
  sleepImpl = wait
} = {}) {
  if (request?.model !== DEEPSEEK_V4_FLASH_MODEL) {
    throw new AIProviderError('Unsupported DeepSeek model', {
      code: 'UNSUPPORTED_AI_MODEL',
      status: 500
    });
  }
  if (!apiKey) {
    throw new AIProviderError('DEEPSEEK_API_KEY is not configured', {
      code: 'AI_NOT_CONFIGURED',
      status: 503
    });
  }
  if (typeof fetchImpl !== 'function') {
    throw new AIProviderError('Fetch is unavailable for the DeepSeek provider', {
      code: 'AI_NOT_CONFIGURED',
      status: 503
    });
  }

  const config = request.config || {};
  const prompt = typeof request.contents === 'string'
    ? request.contents
    : JSON.stringify(request.contents ?? '');
  const messages = [];
  if (config.systemInstruction) {
    messages.push({ role: 'system', content: String(config.systemInstruction) });
  }
  messages.push({ role: 'user', content: prompt });

  const enabled = thinkingEnabled !== false;
  const effort = reasoningEffort === 'max' ? 'max' : 'high';
  const body = {
    model: DEEPSEEK_V4_FLASH_MODEL,
    messages,
    stream: false,
    thinking: { type: enabled ? 'enabled' : 'disabled' }
  };

  const maxTokens = safeInteger(config.maxOutputTokens);
  if (maxTokens) body.max_tokens = maxTokens;
  if (config.responseMimeType === 'application/json') {
    body.response_format = { type: 'json_object' };
  }
  if (enabled) {
    body.reasoning_effort = effort;
  } else if (Number.isFinite(config.temperature)) {
    body.temperature = Math.min(Math.max(config.temperature, 0), 2);
  }

  const endpoint = deepSeekChatCompletionsUrl(baseUrl);
  let response;
  let lastNetworkError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal
      });
      lastNetworkError = null;
    } catch (error) {
      lastNetworkError = error;
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || attempt >= maxRetries) {
        break;
      }
      await sleepImpl(Math.min(250 * (2 ** attempt), 2_000));
      continue;
    }

    if (response.ok) break;
    if (!TRANSIENT_DEEPSEEK_STATUSES.has(response.status) || attempt >= maxRetries) {
      const message = await readDeepSeekError(response);
      throw new AIProviderError(message, {
        code: response.status === 401 ? 'AI_AUTH_FAILED' : 'AI_UPSTREAM_ERROR',
        status: response.status,
        retryable: TRANSIENT_DEEPSEEK_STATUSES.has(response.status)
      });
    }
    await sleepImpl(retryDelayMs(response, attempt));
  }

  if (lastNetworkError) {
    const timedOut = lastNetworkError?.name === 'AbortError' || lastNetworkError?.name === 'TimeoutError';
    throw new AIProviderError(timedOut ? 'DeepSeek request timed out' : 'DeepSeek request failed', {
      code: timedOut ? 'AI_TIMEOUT' : 'AI_UPSTREAM_ERROR',
      status: timedOut ? 504 : 502,
      retryable: true
    });
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new AIProviderError('DeepSeek returned an invalid response', {
      code: 'INVALID_AI_RESPONSE',
      status: 502
    });
  }

  const choice = data?.choices?.[0];
  const text = typeof choice?.message?.content === 'string'
    ? choice.message.content.trim()
    : '';
  if (!text) {
    // DeepSeek documents rare empty JSON-mode responses and recommends retrying.
    // Reuse at most one of the bounded retry attempts for that condition.
    if (maxRetries > 0) {
      return generateDeepSeekContent(request, {
        apiKey,
        baseUrl,
        fetchImpl,
        maxRetries: 0,
        reasoningEffort,
        thinkingEnabled,
        signal,
        sleepImpl
      });
    }
    throw new AIProviderError('DeepSeek returned an empty response', {
      code: 'INVALID_AI_RESPONSE',
      status: 502
    });
  }

  const usage = data.usage || {};
  const finishReason = String(choice.finish_reason || 'UNKNOWN').toUpperCase();
  const usageMetadata = {
    promptTokenCount: safeInteger(usage.prompt_tokens),
    candidatesTokenCount: safeInteger(usage.completion_tokens),
    totalTokenCount: safeInteger(usage.total_tokens),
    cachedContentTokenCount: safeInteger(usage.prompt_cache_hit_tokens) || 0,
    thoughtsTokenCount: safeInteger(usage.completion_tokens_details?.reasoning_tokens) || 0
  };

  return {
    text,
    modelVersion: typeof data.model === 'string' ? data.model : request.model,
    usageMetadata,
    candidates: [{ content: { parts: [{ text }] }, finishReason }]
  };
}
