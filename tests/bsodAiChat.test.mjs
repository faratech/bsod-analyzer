import test, { after } from 'node:test';
import { createMountTracker, failFileAfter, JSDOM_FILE_TIMEOUT_MS } from './helpers/jsdomCleanup.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rolldown } from 'rolldown';
import { JSDOM } from 'jsdom';

// Renders the real BsodAiChat (React bundled in) into jsdom with a scripted
// network: what it asks the server, what it shows for each answer and failure.
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const file = (...parts) => JSON.stringify(path.join(root, ...parts));
const HARNESS = `
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import BsodAiChat from ${file('components', 'BsodAiChat.tsx')};
import { stopSessionRefresh } from ${file('utils', 'sessionManager.ts')};
export function mount(container, props) {
  const r = createRoot(container);
  return {
    async render() { await act(async () => { r.render(React.createElement(BsodAiChat, props)); }); },
    async unmount() { await act(async () => { r.unmount(); }); },
  };
}
export { act, stopSessionRefresh };
`;

async function loadHarness() {
  const bundle = await rolldown({
    input: 'harness',
    platform: 'browser',
    logLevel: 'silent',
    transform: { define: { 'process.env.NODE_ENV': '"development"' } },
    plugins: [{
      name: 'harness',
      resolveId: id => (id === 'harness' ? id : null),
      load: id => (id === 'harness' ? HARNESS : null),
    }],
  });
  const { output } = await bundle.generate({ format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(output[0].code, 'utf8').toString('base64')}`);
}

const channels = [];
const NodeMessageChannel = globalThis.MessageChannel;
globalThis.MessageChannel = class extends NodeMessageChannel {
  constructor() {
    super();
    channels.push(this);
  }
};
after(() => {
  h.stopSessionRefresh('analyzer-page');
  for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
});

const requests = [];
let script = {};

function installDom() {
  const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', { url: 'https://bsod.windowsforum.com/analyzer' });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'File']) {
    Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : dom.window[key], configurable: true, writable: true });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  requests.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ url, method: init.method, headers: init.headers, credentials: init.credentials, body });
    const reply = script[url];
    const next = typeof reply === 'function' ? reply(body) : reply;
    // `sse`: a list of [event, data] pairs sent as a stream, one per read; `hold` waits on a promise before the next.
    const headers = { ...(next.headers || {}), ...(next.sse ? { 'Content-Type': 'text/event-stream' } : {}) };
    const enc = new TextEncoder();
    const stream = next.sse && new ReadableStream({
      async start(controller) {
        for (const item of next.sse) {
          if (item.hold) await item.hold;
          else controller.enqueue(enc.encode(`event: ${item[0]}\ndata: ${JSON.stringify(item[1])}\n\n`));
        }
        controller.close();
      },
    });
    return {
      ok: next.status === undefined || next.status < 400,
      status: next.status ?? 200,
      headers: { get: name => headers[name] ?? null },
      body: stream,
      json: async () => next.json,
    };
  };
  return dom;
}

// React decides how to listen to input events when it loads, so a DOM must exist first.
installDom();
const h = await loadHarness();
failFileAfter(JSDOM_FILE_TIMEOUT_MS, 'bsodAiChat.test.mjs');
const track = createMountTracker();

const FILE = {
  id: 'f1', file: { name: '102925-1.dmp' }, displayName: '102925-1.dmp', fileHash: 'a'.repeat(64),
  status: 'analyzed',
  report: { summary: 'A driver crashed', probableCause: 'bad.sys touched freed memory', culprit: 'bad.sys', recommendations: ['Update bad.sys'], bugCheckCode: '0xD1', bugCheckName: 'DRIVER_IRQL_NOT_LESS_OR_EQUAL' },
};

async function open(statusJson) {
  const dom = installDom();
  script = {
    '/api/bsod-ai/status': { json: { enabled: true, pass: true, limit: 8, windowMinutes: 60, model: 'gpt-6-luna', ...statusJson } },
  };
  const container = dom.window.document.getElementById('root');
  const view = h.mount(container, { files: [FILE], onClose: () => {} });
  view.unmount = track(view.unmount);
  await view.render();
  await h.act(async () => { await new Promise(r => setTimeout(r, 20)); });
  return { dom, container, view };
}

const settle = () => h.act(async () => { await new Promise(r => setTimeout(r, 20)); });

async function typeAndSend(dom, container, text) {
  const input = container.querySelector('input');
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  await h.act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await h.act(async () => { container.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
  await settle();
}

test('when the chat is switched off nothing is shown', async () => {
  const { container, view } = await open({ enabled: false });
  assert.equal(container.querySelector('.ai-chat'), null);
  await view.unmount();
});

test('with a pass it offers the suggested questions, and a chip asks the server with the report and the file handle', async () => {
  const { dom, container, view } = await open({});
  assert.match(container.textContent, /Hi, I'm BSOD AI/);
  const chips = [...container.querySelectorAll('.ai-chip')].map(b => b.textContent);
  assert.deepEqual(chips, ['Is it my hardware?', 'Which driver is it?', 'How do I fix it?', 'Can I ignore it?']);

  script['/api/bsod-ai/ask'] = { json: { success: true, answer: 'bad.sys is the main suspect.', evidence: ['bad.sys', 'stack frame 3'], remaining: 7 } };
  await h.act(async () => { container.querySelectorAll('.ai-chip')[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  await settle();

  const ask = requests.find(r => r.url === '/api/bsod-ai/ask');
  assert.equal(ask.method, 'POST');
  assert.equal(ask.credentials, 'include');
  assert.ok(ask.headers['X-Data-Use-Terms'], 'the data-use terms travel with the question');
  assert.equal(ask.body.question, 'Which driver is it?');
  assert.deepEqual(ask.body.history, []);
  assert.equal(ask.body.fileHash, 'a'.repeat(64));
  assert.equal(ask.body.report.culprit, 'bad.sys');
  assert.match(ask.body.report.bugcheck, /D1/);

  const texts = [...container.querySelectorAll('.ai-msg')].map(m => m.textContent);
  assert.equal(texts[0], 'Which driver is it?');
  assert.match(texts[1], /bad\.sys is the main suspect\./);
  assert.match(texts[1], /Based on: bad\.sys · stack frame 3/);
  assert.match(container.textContent, /7 of 8 questions left this hour/);
  assert.equal(container.querySelector('.ai-chips'), null, 'the chips give way to the conversation');

  // The next question carries the conversation so far.
  script['/api/bsod-ai/ask'] = { json: { success: true, answer: 'Update it from the maker.', evidence: [], remaining: 6 } };
  await typeAndSend(dom, container, 'How do I fix it?');
  const second = requests.filter(r => r.url === '/api/bsod-ai/ask')[1];
  assert.deepEqual(second.body.history.map(t => t.role), ['user', 'assistant']);
  await view.unmount();
});

test('an out-of-capacity answer keeps the question and says it was not counted', async () => {
  const { dom, container, view } = await open({});
  script['/api/bsod-ai/ask'] = { status: 503, json: { success: false, code: 'BSOD_AI_RESTING', error: 'resting' } };
  await typeAndSend(dom, container, 'Which driver is it?');
  assert.match(container.querySelector('.ai-note').textContent, /resting.*not counted/s);
  assert.equal(container.querySelector('input').value, 'Which driver is it?', 'the question is back in the box');
  assert.equal(container.querySelectorAll('.ai-msg').length, 0);
  await view.unmount();
});

test('an exhausted allowance and a lockout are explained, and the box is closed to more questions', async () => {
  const { dom, container, view } = await open({});
  script['/api/bsod-ai/ask'] = { status: 429, json: { success: false, code: 'BSOD_AI_QUOTA', error: 'quota' } };
  await typeAndSend(dom, container, 'Which driver is it?');
  assert.match(container.querySelector('.ai-note').textContent, /questions for this hour/);
  assert.equal(container.querySelector('input').disabled, true);
  await view.unmount();

  const second = await open({});
  script['/api/bsod-ai/ask'] = { status: 429, json: { success: false, code: 'BSOD_AI_LOCKED', error: 'locked' }, headers: { 'Retry-After': '1800' } };
  await typeAndSend(second.dom, second.container, 'Which driver is it?');
  assert.match(second.container.querySelector('.ai-note').textContent, /taking a break/);
  await second.view.unmount();
});

test('a refused question is shown in the persona\'s voice', async () => {
  const { dom, container, view } = await open({});
  script['/api/bsod-ai/ask'] = { json: { success: true, refused: true, kind: 'off_topic', answer: "That's not about your crash.", evidence: [] } };
  await typeAndSend(dom, container, 'write me a poem');
  assert.match([...container.querySelectorAll('.ai-gm')].at(-1).textContent, /not about your crash/);
  assert.equal(container.querySelector('.ai-avatar .gr').getAttribute('data-gs'), 'shrug');
  await view.unmount();
});

test('without a pass the security check comes first, and the box is locked until it is solved', async () => {
  const { container, view } = await open({ pass: false });
  assert.match(container.querySelector('.ai-verify').textContent, /security check/);
  assert.equal(container.querySelector('input').disabled, true);
  assert.equal(container.querySelector('.ai-chips'), null);
  await view.unmount();
});

test('a pass that expired mid-conversation brings the check back and keeps the question', async () => {
  const { dom, container, view } = await open({});
  script['/api/bsod-ai/ask'] = { status: 403, json: { success: false, code: 'AI_PASS_REQUIRED', error: 'pass' } };
  await typeAndSend(dom, container, 'Which driver is it?');
  assert.ok(container.querySelector('.ai-verify'));
  assert.equal(container.querySelector('input').value, 'Which driver is it?');
  await view.unmount();
});

test('the conversation is announced politely and the controls are labelled', async () => {
  const { container, view } = await open({});
  const log = container.querySelector('[role="log"]');
  assert.equal(log.getAttribute('aria-live'), 'polite');
  assert.ok(container.querySelector('label[for="bsod-ai-input"]'));
  assert.ok(container.querySelector('button[aria-label="Send question"]'));
  assert.ok(container.querySelector('button[aria-label="Close BSOD AI"]'));
  assert.equal(container.querySelector('input').maxLength, 500);
  await view.unmount();
});

test('a streamed answer grows in a hidden bubble, then replaces it with one announced answer', async () => {
  const { dom, container, view } = await open({});
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  script['/api/bsod-ai/ask'] = {
    sse: [
      ['delta', { text: 'bad.sys is the suspect. ' }],
      { hold: gate },
      ['delta', { text: 'Update it.' }],
      ['done', { answer: 'bad.sys is the suspect. Update it.', evidence: ['bad.sys'], remaining: 6 }],
    ],
  };
  await typeAndSend(dom, container, 'Which driver is it?');
  const ask = requests.find(r => r.url === '/api/bsod-ai/ask');
  assert.equal(ask.body.stream, true);
  // Mid-answer: the first sentence is on screen, hidden from screen readers, and the box is busy.
  const live = container.querySelector('.ai-msg[aria-hidden="true"]');
  assert.match(live.textContent, /^bad\.sys is the suspect\./);
  assert.equal(container.querySelector('[aria-label="BSOD AI is thinking"]'), null, 'the dots give way once text arrives');
  assert.equal(container.querySelector('button[aria-label="Send question"]').disabled, true);
  release();
  await settle();
  const texts = [...container.querySelectorAll('.ai-msg')].map(m => m.textContent);
  assert.equal(container.querySelector('.ai-msg[aria-hidden="true"]'), null);
  assert.equal(texts.length, 2);
  assert.match(texts[1], /^bad\.sys is the suspect\. Update it\./);
  assert.match(texts[1], /Based on: bad\.sys/);
  assert.match(container.textContent, /6 of 8 questions left this hour/);
  await view.unmount();
});

test('a stream that fails after some text keeps what was shown and says so; one that fails first restores the question', async () => {
  const { dom, container, view } = await open({});
  script['/api/bsod-ai/ask'] = {
    sse: [['delta', { text: 'bad.sys is the suspect. ' }], ['error', { code: 'BSOD_AI_FAILED', error: 'BSOD AI stopped mid-answer. Try again.' }]],
  };
  await typeAndSend(dom, container, 'Which driver is it?');
  const texts = [...container.querySelectorAll('.ai-msg')].map(m => m.textContent);
  assert.equal(texts.length, 2);
  assert.match(texts[1], /bad\.sys is the suspect\./);
  assert.match(container.querySelector('.ai-note').textContent, /stopped mid-answer/);
  assert.equal(container.querySelector('input').value, '');
  await view.unmount();

  const second = await open({});
  script['/api/bsod-ai/ask'] = { status: 502, json: { success: false, code: 'BSOD_AI_FAILED', error: 'BSOD AI could not answer.' } };
  await typeAndSend(second.dom, second.container, 'Which driver is it?');
  assert.equal(second.container.querySelector('input').value, 'Which driver is it?');
  assert.equal(second.container.querySelectorAll('.ai-msg').length, 0);
  await second.view.unmount();
});

test('answers render bold, inline code and bullets as elements, and never as HTML', async () => {
  const { dom, container, view } = await open({});
  script['/api/bsod-ai/ask'] = {
    json: {
      success: true, remaining: 7, evidence: [],
      answer: 'The **bad.sys** driver crashed. Run `sfc /scannow`.\n- Update it\n- Restart\n<img src=x onerror=alert(1)> **half open',
    },
  };
  await typeAndSend(dom, container, 'Which driver is it?');
  const reply = [...container.querySelectorAll('.ai-gm')].at(-1);
  assert.equal(reply.querySelector('strong').textContent, 'bad.sys');
  assert.equal(reply.querySelector('code').textContent, 'sfc /scannow');
  assert.deepEqual([...reply.querySelectorAll('li')].map(li => li.textContent), ['Update it', 'Restart']);
  assert.equal(reply.querySelector('img'), null, 'text that looks like HTML stays text');
  assert.match(reply.textContent, /<img src=x onerror=alert\(1\)> half open/, 'an unmatched marker is dropped, the words stay');
  assert.doesNotMatch(reply.textContent, /\*\*/);
  // The visitor's own message is never parsed.
  const mine = container.querySelector('.ai-me');
  assert.equal(mine.querySelector('strong'), null);
  await view.unmount();
});

test('a streamed answer shows bold only once its closing marker has arrived', async () => {
  const { dom, container, view } = await open({});
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  script['/api/bsod-ai/ask'] = {
    sse: [
      ['delta', { text: 'The **bad.' }],
      { hold: gate },
      ['delta', { text: 'sys** driver.' }],
      ['done', { answer: 'The **bad.sys** driver.', evidence: [], remaining: 5 }],
    ],
  };
  await typeAndSend(dom, container, 'Which driver is it?');
  const live = container.querySelector('.ai-msg[aria-hidden="true"]');
  assert.equal(live.querySelector('strong'), null);
  assert.match(live.textContent, /^The bad\./);
  release();
  await settle();
  assert.equal([...container.querySelectorAll('.ai-gm')].at(-1).querySelector('strong').textContent, 'bad.sys');
  await view.unmount();
});
