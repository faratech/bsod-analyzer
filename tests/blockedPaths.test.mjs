import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRequestPath } from '../server/blockedPaths.js';

test('blocks sensitive paths in raw and percent-encoded form', () => {
  for (const p of ['/.env', '/%2Eenv', '/%2eENV', '/assets/app.js.map', '/assets/app.js%2Emap',
    '/src/main.tsx', '/%73rc/main.tsx', '/package.json', '/node_modules/x/index.js', '/.git/config']) {
    assert.equal(classifyRequestPath(p), 'blocked', p);
  }
});

test('rejects undecodable escapes and NUL bytes', () => {
  assert.equal(classifyRequestPath('/%E0%A4%A'), 'invalid');
  assert.equal(classifyRequestPath('/index.html%00.png'), 'invalid');
});

test('passes ordinary pages and assets', () => {
  for (const p of ['/', '/analyzer', '/assets/index-abc123.js', '/assets/index-abc.css', '/privacy', '/stats/embed']) {
    assert.equal(classifyRequestPath(p), null, p);
  }
});
