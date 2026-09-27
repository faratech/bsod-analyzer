import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BSOD_FORUM_URL,
  bsodPostThreadUrl,
  forumThreadTitle,
  isForumUrl,
  relatedKeysFromReport,
  withForumUtm
} from '../shared/forumLinks.js';

test('the BSOD board is node 307', () => {
  assert.equal(BSOD_FORUM_URL, 'https://windowsforum.com/forums/windows-blue-screen-of-death-bsod.307/');
});

test('only https forum hosts count as forum URLs and get campaign tags', () => {
  assert.equal(isForumUrl('https://windowsforum.com/threads/1/'), true);
  assert.equal(isForumUrl('https://www.windowsforum.com/threads/1/'), true);
  assert.equal(isForumUrl('http://windowsforum.com/threads/1/'), false);
  assert.equal(isForumUrl('https://windowsforum.com.evil.example/'), false);
  assert.equal(isForumUrl('javascript:alert(1)'), false);

  const tagged = new URL(withForumUtm('https://windowsforum.com/threads/1/#post-2'));
  assert.equal(tagged.searchParams.get('utm_source'), 'bsod.windowsforum.com');
  assert.equal(tagged.searchParams.get('utm_campaign'), 'related_threads');
  assert.equal(tagged.hash, '#post-2');
  assert.equal(withForumUtm('https://evil.example/x'), 'https://evil.example/x');
});

test('post-thread URL targets the BSOD board with an encoded title', () => {
  const url = new URL(bsodPostThreadUrl('BSOD DPC_WATCHDOG_VIOLATION (0x133) – nvlddmkm.sys & more'));
  assert.equal(url.origin + url.pathname, `${BSOD_FORUM_URL}post-thread`);
  assert.equal(url.searchParams.get('title'), 'BSOD DPC_WATCHDOG_VIOLATION (0x133) – nvlddmkm.sys & more');
  assert.equal(url.searchParams.get('utm_campaign'), 'ask_community');
  assert.equal(new URL(bsodPostThreadUrl('')).searchParams.has('title'), false);
});

test('thread titles use only identifier-shaped tokens from the dump', () => {
  assert.equal(
    forumThreadTitle({ code: '0x00000133', name: 'DPC_WATCHDOG_VIOLATION', module: 'nvlddmkm.sys' }),
    'BSOD DPC_WATCHDOG_VIOLATION (0x133) – nvlddmkm.sys'
  );
  assert.equal(forumThreadTitle({ code: '0x1a' }), 'BSOD 0x1A');
  assert.equal(forumThreadTitle({ module: 'rtwlane.sys' }), 'BSOD rtwlane.sys');
  assert.equal(
    forumThreadTitle({ code: 'visit evil.example', name: 'Free <b>money</b>', module: 'a b.sys' }),
    'BSOD crash analysis – help needed'
  );
  assert.ok(forumThreadTitle({ name: 'X'.repeat(64), module: 'y'.repeat(64) }).length <= 100);
});

test('related keys come from the structured report fields', () => {
  assert.deepEqual(relatedKeysFromReport({
    bugCheck: { code: '0x133', name: 'DPC_WATCHDOG_VIOLATION', parameters: [] },
    imageName: 'nvlddmkm.sys',
    culprit: 'NVIDIA display driver'
  }), { code: '0x133', name: 'DPC_WATCHDOG_VIOLATION', module: 'nvlddmkm.sys' });
  assert.deepEqual(relatedKeysFromReport({ bugCheckCode: '0x1A', culprit: 'rtwlane.sys' }), { code: '0x1A', name: '', module: 'rtwlane.sys' });
  assert.deepEqual(relatedKeysFromReport({ crashLocation: { module: 'dxgkrnl.sys', address: '' }, culprit: 'x' }), { code: '', name: '', module: 'dxgkrnl.sys' });
  assert.equal(relatedKeysFromReport({ culprit: 'Faulty RAM' }), null);
  assert.equal(relatedKeysFromReport(null), null);
});
