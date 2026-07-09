import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AIProviderError,
  DEFAULT_GEMINI_MODEL,
  DEEPSEEK_V4_FLASH_MODEL,
  generateDeepSeekContent,
  getAIProviderForModel,
  getCachedAIReportForModel,
  isSupportedAIModel,
  normalizeDeepSeekApiBaseUrl
} from '../services/aiProvider.js';

test('AI provider selection accepts server-supported model IDs only', () => {
  assert.equal(getAIProviderForModel(DEFAULT_GEMINI_MODEL), 'gemini');
  assert.equal(getAIProviderForModel('gemini-3.5-flash'), 'gemini');
  assert.equal(getAIProviderForModel(DEEPSEEK_V4_FLASH_MODEL), 'deepseek');
  assert.equal(getAIProviderForModel('deepseek-v4-pro'), null);
  assert.equal(getAIProviderForModel('../../deepseek-v4-flash'), null);
  assert.equal(isSupportedAIModel('not-a-model'), false);
});

test('model-aware cache lookup never crosses AI providers', () => {
  const geminiReport = { text: '{"summary":"Gemini"}' };
  const deepSeekReport = { text: '{"summary":"DeepSeek"}' };
  const cached = {
    aiModel: DEEPSEEK_V4_FLASH_MODEL,
    aiReport: deepSeekReport,
    aiReports: {
      [DEFAULT_GEMINI_MODEL]: geminiReport,
      [DEEPSEEK_V4_FLASH_MODEL]: deepSeekReport
    }
  };

  assert.equal(getCachedAIReportForModel(cached, DEFAULT_GEMINI_MODEL), geminiReport);
  assert.equal(getCachedAIReportForModel(cached, DEEPSEEK_V4_FLASH_MODEL), deepSeekReport);
  assert.equal(getCachedAIReportForModel(cached, 'gemini-3.5-flash'), null);
  assert.equal(getCachedAIReportForModel({ aiReport: geminiReport }, DEFAULT_GEMINI_MODEL), geminiReport);
  assert.equal(getCachedAIReportForModel({ aiReport: geminiReport }, DEEPSEEK_V4_FLASH_MODEL), null);
});

test('DeepSeek base URL normalization accepts a base or full endpoint', () => {
  assert.equal(normalizeDeepSeekApiBaseUrl('api.deepseek.com/'), 'https://api.deepseek.com');
  assert.equal(normalizeDeepSeekApiBaseUrl('http://localhost:3000/'), 'http://localhost:3000');
  assert.equal(
    normalizeDeepSeekApiBaseUrl('https://api.deepseek.com/chat/completions/'),
    'https://api.deepseek.com/chat/completions'
  );
  assert.throws(
    () => normalizeDeepSeekApiBaseUrl('http://api.deepseek.com'),
    error => error instanceof AIProviderError && error.code === 'DEEPSEEK_INVALID_BASE_URL'
  );
});

test('DeepSeek adapter sends server-owned JSON thinking request and normalizes its response', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({
      model: DEEPSEEK_V4_FLASH_MODEL,
      choices: [{
        finish_reason: 'stop',
        message: { content: '{"summary":"ok","probableCause":"driver","culprit":"x.sys","recommendations":["update"]}' }
      }],
      usage: {
        prompt_tokens: 125,
        completion_tokens: 40,
        total_tokens: 165,
        prompt_cache_hit_tokens: 100,
        completion_tokens_details: { reasoning_tokens: 12 }
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const result = await generateDeepSeekContent({
    model: DEEPSEEK_V4_FLASH_MODEL,
    contents: 'Analyze this dump and return JSON.',
    config: {
      systemInstruction: 'Return structured JSON only.',
      responseMimeType: 'application/json',
      temperature: 0.5,
      maxOutputTokens: 4096
    }
  }, {
    apiKey: 'test-key',
    fetchImpl,
    maxRetries: 0,
    reasoningEffort: 'high'
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-key');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, DEEPSEEK_V4_FLASH_MODEL);
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'Return structured JSON only.' },
    { role: 'user', content: 'Analyze this dump and return JSON.' }
  ]);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.deepEqual(body.thinking, { type: 'enabled' });
  assert.equal(body.reasoning_effort, 'high');
  assert.equal(body.max_tokens, 4096);
  assert.equal('temperature' in body, false);

  assert.match(result.text, /"summary":"ok"/);
  assert.equal(result.modelVersion, DEEPSEEK_V4_FLASH_MODEL);
  assert.equal(result.candidates[0].finishReason, 'STOP');
  assert.deepEqual(result.usageMetadata, {
    promptTokenCount: 125,
    candidatesTokenCount: 40,
    totalTokenCount: 165,
    cachedContentTokenCount: 100,
    thoughtsTokenCount: 12
  });
});

test('DeepSeek adapter retries transient responses and does not retry authentication failures', async () => {
  let transientCalls = 0;
  const recovered = await generateDeepSeekContent({
    model: DEEPSEEK_V4_FLASH_MODEL,
    contents: 'Return JSON.',
    config: { responseMimeType: 'application/json' }
  }, {
    apiKey: 'test-key',
    sleepImpl: async () => {},
    fetchImpl: async () => {
      transientCalls++;
      if (transientCalls === 1) {
        return new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 503 });
      }
      return new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
        usage: {}
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  });
  assert.equal(transientCalls, 2);
  assert.equal(recovered.text, '{"ok":true}');

  let authCalls = 0;
  await assert.rejects(
    generateDeepSeekContent({
      model: DEEPSEEK_V4_FLASH_MODEL,
      contents: 'Return JSON.',
      config: {}
    }, {
      apiKey: 'bad-key',
      fetchImpl: async () => {
        authCalls++;
        return new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 });
      },
      sleepImpl: async () => {}
    }),
    error => error instanceof AIProviderError && error.code === 'AI_AUTH_FAILED'
  );
  assert.equal(authCalls, 1);
});

test('DeepSeek adapter supports non-thinking mode and rejects empty responses', async () => {
  let requestBody;
  await assert.rejects(
    generateDeepSeekContent({
      model: DEEPSEEK_V4_FLASH_MODEL,
      contents: 'Return JSON.',
      config: { temperature: 0.25 }
    }, {
      apiKey: 'test-key',
      thinkingEnabled: false,
      maxRetries: 0,
      fetchImpl: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return new Response(JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: '' } }],
          usage: {}
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }),
    error => error instanceof AIProviderError && error.code === 'INVALID_AI_RESPONSE'
  );

  assert.deepEqual(requestBody.thinking, { type: 'disabled' });
  assert.equal(requestBody.temperature, 0.25);
  assert.equal('reasoning_effort' in requestBody, false);
});

test('DeepSeek adapter retries a rare empty JSON-mode response once', async () => {
  let calls = 0;
  const result = await generateDeepSeekContent({
    model: DEEPSEEK_V4_FLASH_MODEL,
    contents: 'Return JSON.',
    config: { responseMimeType: 'application/json' }
  }, {
    apiKey: 'test-key',
    fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: 'stop',
          message: { content: calls === 1 ? '' : '{"ok":true}' }
        }],
        usage: {}
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  });

  assert.equal(calls, 2);
  assert.equal(result.text, '{"ok":true}');
});
