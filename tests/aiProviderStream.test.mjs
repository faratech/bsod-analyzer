import test from 'node:test';
import assert from 'node:assert/strict';
import { generateExperientialContent, generateOpenAIContent, readChatCompletionStream, AIProviderError } from '../services/aiProvider.js';

const enc = new TextEncoder();
const chunk = (delta, extra = {}) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: 'gpt-6-luna', choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
const finish = `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`;
const usage = (p, c) => `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c } })}\n\n`;

// A streaming Response whose reads are cut at the given byte offsets.
function sse(text, { cuts = [], status = 200 } = {}) {
  const bytes = enc.encode(text);
  const edges = [0, ...cuts, bytes.length];
  let i = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (i >= edges.length - 1) return controller.close();
      controller.enqueue(bytes.slice(edges[i], edges[i + 1]));
      i += 1;
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

test('the stream is rebuilt into the object a normal call returns, deltas in order, usage from the last chunk', async () => {
  const deltas = [];
  const text = chunk({ role: 'assistant' }) + chunk({ content: 'bad.sys ' }) + chunk({ content: 'is the suspect.' }) + finish + usage(120, 30) + 'data: [DONE]\n\n';
  const data = await readChatCompletionStream(sse(text), { onDelta: d => deltas.push(d) });
  assert.deepEqual(deltas, ['bad.sys ', 'is the suspect.']);
  assert.equal(data.choices[0].message.content, 'bad.sys is the suspect.');
  assert.equal(data.choices[0].finish_reason, 'stop');
  assert.deepEqual(data.usage, { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 });
  assert.equal(data.model, 'gpt-6-luna');
});

test('events split anywhere across network reads, CRLF line ends, comments and unknown lines are all fine', async () => {
  const text = ': keep-alive\r\n\r\nevent: message\r\n' + chunk({ content: 'Héllo ✓ ' }).replace(/\n/g, '\r\n') + chunk({ content: 'world' }) + finish + 'data: [DONE]\n\n';
  const whole = enc.encode(text);
  const cuts = Array.from({ length: 40 }, (_, k) => 3 + k * 7).filter(n => n < whole.length);
  const deltas = [];
  const data = await readChatCompletionStream(sse(text, { cuts }), { onDelta: d => deltas.push(d) });
  assert.equal(data.choices[0].message.content, 'Héllo ✓ world', 'a multi-byte character cut between reads survives');
  assert.equal(deltas.join(''), 'Héllo ✓ world');
});

test('a stream that ends without [DONE] or a finish reason is reported as cut', async () => {
  const data = await readChatCompletionStream(sse(chunk({ content: 'partial' })));
  assert.equal(data.choices[0].message.content, 'partial');
  assert.equal(data.choices[0].finish_reason, null);
});

test('an error chunk mid-stream, a non-stream body and an oversized stream are provider errors', async () => {
  await assert.rejects(
    () => readChatCompletionStream(sse(chunk({ content: 'x' }) + `data: ${JSON.stringify({ error: { message: 'boom' } })}\n\n`)),
    error => error instanceof AIProviderError && error.code === 'AI_UPSTREAM_ERROR' && /boom/.test(error.message)
  );
  await assert.rejects(() => readChatCompletionStream({ body: null }), error => error.code === 'INVALID_AI_RESPONSE');
  const big = new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(500_000)); } }));
  await assert.rejects(() => readChatCompletionStream(big), error => error.code === 'INVALID_AI_RESPONSE' && /too large/.test(error.message));
});

for (const [name, generate] of [['Experiential', generateExperientialContent], ['OpenAI', generateOpenAIContent]]) {
  test(`${name}: a streaming call asks for a stream with usage, passes deltas on, and returns the normal result`, async () => {
    const sent = [];
    const deltas = [];
    const fetchImpl = async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return sse(chunk({ content: 'Update the driver.' }) + finish + usage(900, 40) + 'data: [DONE]\n\n');
    };
    const result = await generate({ contents: 'q', config: { systemInstruction: 's', jsonObjectMode: false, maxOutputTokens: 450 } }, { apiKey: 'k', fetchImpl, onDelta: d => deltas.push(d) });
    assert.equal(sent[0].body.stream, true);
    assert.deepEqual(sent[0].body.stream_options, { include_usage: true });
    assert.equal(sent[0].body.max_completion_tokens, 450);
    assert.deepEqual(deltas, ['Update the driver.']);
    assert.equal(result.text, 'Update the driver.');
    assert.equal(result.usageMetadata.promptTokenCount, 900);
    assert.equal(result.usageMetadata.candidatesTokenCount, 40);
    assert.equal(result.candidates[0].finishReason, 'STOP');
  });

  test(`${name}: without onDelta nothing changes (a plain, non-streaming body)`, async () => {
    let body;
    const fetchImpl = async (url, init) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ model: 'm', choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
    };
    const result = await generate({ contents: 'q', config: {} }, { apiKey: 'k', fetchImpl });
    assert.equal(body.stream, false);
    assert.equal('stream_options' in body, false);
    assert.equal(result.text, 'hi');
  });

  test(`${name}: an error status before the stream still maps as before and never starts a stream`, async () => {
    const deltas = [];
    const fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'daily quota exhausted', code: 'insufficient_quota', type: 'insufficient_quota' } }), { status: 429 });
    await assert.rejects(
      () => generate({ contents: 'q', config: {} }, { apiKey: 'k', fetchImpl, maxRetries: 0, onDelta: d => deltas.push(d) }),
      error => error.code === 'AI_QUOTA_EXHAUSTED' || error.code === 'AI_DAILY_QUOTA_EXHAUSTED'
    );
    assert.deepEqual(deltas, []);
  });

  test(`${name}: an empty stream is an invalid response that still carries the usage`, async () => {
    const fetchImpl = async () => sse(finish + usage(500, 60) + 'data: [DONE]\n\n');
    await assert.rejects(
      () => generate({ contents: 'q', config: {} }, { apiKey: 'k', fetchImpl, maxRetries: 0, onDelta: () => {} }),
      error => error.code === 'INVALID_AI_RESPONSE' && error.usageMetadata?.totalTokenCount === 560
    );
  });

  test(`${name}: an abort mid-stream is a timeout, and the deltas already delivered stay delivered`, async () => {
    const controller = new AbortController();
    const deltas = [];
    const fetchImpl = async (url, init) => {
      const body = new ReadableStream({
        async pull(c) {
          c.enqueue(enc.encode(chunk({ content: 'first ' })));
          await new Promise(resolve => setTimeout(resolve, 20));
          if (init.signal.aborted) return c.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          c.enqueue(enc.encode(chunk({ content: 'second ' })));
        },
      });
      return new Response(body, { status: 200 });
    };
    await assert.rejects(
      () => generate({ contents: 'q', config: {} }, { apiKey: 'k', fetchImpl, signal: controller.signal, maxRetries: 0, onDelta: d => { deltas.push(d); controller.abort(); } }),
      error => error.code === 'AI_TIMEOUT'
    );
    assert.equal(deltas[0], 'first ');
  });
}
