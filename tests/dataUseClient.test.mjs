import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rolldown } from 'rolldown';

import { DATA_USE_TERMS_HEADER, DATA_USE_TERMS_VERSION } from '../shared/dataUseTerms.js';

// utils/dataUse.ts imports ../shared/dataUseTerms.js, so it is bundled.
async function loadDataUse() {
  const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  const bundle = await rolldown({ input: path.join(root, 'utils', 'dataUse.ts') });
  const { output } = await bundle.generate({ format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(output[0].code, 'utf8').toString('base64')}`);
}

const dataUse = await loadDataUse();

function freshBrowser(initial = {}) {
  const map = new Map(Object.entries(initial));
  globalThis.window = {
    localStorage: {
      getItem: key => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => { map.set(key, String(value)); },
      removeItem: key => { map.delete(key); },
    },
  };
  dataUse.setDataUseAccepted(true);
  return map;
}

test('a browser that agreed to an earlier terms version is asked again (issue #144)', () => {
  freshBrowser({ [dataUse.DATA_USE_ACCEPTED_VERSION_KEY]: '2020-01-01' });
  assert.equal(dataUse.dataUseTermsChangedSinceAcceptance(), true);
});

test('a first visit keeps the default-checked box (nothing to re-ask)', () => {
  freshBrowser();
  assert.equal(dataUse.dataUseTermsChangedSinceAcceptance(), false);
});

test('submitting with the box checked records the version sent, which then counts as current', () => {
  const storage = freshBrowser();
  assert.deepEqual(dataUse.dataUseHeaders(), { [DATA_USE_TERMS_HEADER]: DATA_USE_TERMS_VERSION });
  assert.equal(storage.get(dataUse.DATA_USE_ACCEPTED_VERSION_KEY), DATA_USE_TERMS_VERSION);
  assert.equal(dataUse.dataUseTermsChangedSinceAcceptance(), false);
});

test('checking the box again records the current version', () => {
  const storage = freshBrowser({ [dataUse.DATA_USE_ACCEPTED_VERSION_KEY]: '2020-01-01' });
  dataUse.rememberDataUseAcceptance();
  assert.equal(storage.get(dataUse.DATA_USE_ACCEPTED_VERSION_KEY), DATA_USE_TERMS_VERSION);
  assert.equal(dataUse.dataUseTermsChangedSinceAcceptance(), false);
});

test('a declined box sends no header and records nothing', () => {
  const storage = freshBrowser();
  dataUse.setDataUseAccepted(false);
  assert.deepEqual(dataUse.dataUseHeaders(), {});
  assert.equal(storage.has(dataUse.DATA_USE_ACCEPTED_VERSION_KEY), false);
});

test('blocked storage never throws and never re-asks', () => {
  globalThis.window = { localStorage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } } };
  dataUse.setDataUseAccepted(true);
  assert.equal(dataUse.dataUseTermsChangedSinceAcceptance(), false);
  assert.deepEqual(dataUse.dataUseHeaders(), { [DATA_USE_TERMS_HEADER]: DATA_USE_TERMS_VERSION });
});
