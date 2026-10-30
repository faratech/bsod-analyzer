import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  staticHeadersFor,
  staticContentType,
  staticCacheControl,
  STATIC_REDIRECTS,
  IMMUTABLE_CACHE,
  UNHASHED_CACHE
} from '../server/staticPolicy.js';

// Issue #348: root text files were served with no Content-Type (under a global
// nosniff) and a one-year cache; unhashed root images were immutable.
test('root text files get a real Content-Type (ads.txt must be text/plain)', () => {
  assert.equal(staticHeadersFor('ads.txt')['Content-Type'], 'text/plain; charset=utf-8');
  assert.equal(staticHeadersFor('robots.txt')['Content-Type'], 'text/plain; charset=utf-8');
  assert.equal(staticHeadersFor('.well-known/security.txt')['Content-Type'], 'text/plain; charset=utf-8');
  assert.equal(staticHeadersFor('sitemap.xml')['Content-Type'], 'application/xml; charset=utf-8');
  assert.equal(staticHeadersFor('site.webmanifest')['Content-Type'], 'application/manifest+json; charset=utf-8');
  assert.equal(staticContentType('.unknownext'), 'application/octet-stream');
});

test('only hashed /assets/ output is cached immutable; unhashed files get one day', () => {
  for (const rel of ['assets/index-abc123.js', 'assets/index-abc.css', 'assets/font-x.woff2']) {
    assert.equal(staticCacheControl(rel), IMMUTABLE_CACHE, rel);
  }
  for (const rel of ['ads.txt', 'robots.txt', 'sitemap.xml', 'site.webmanifest', 'favicon.ico',
    'og-image.webp', 'android-chrome-512x512.png', 'images/comparison-windbg.webp',
    'symbols/ntoskrnl.json', '.well-known/security.txt', 'no-extension']) {
    const value = staticCacheControl(rel);
    assert.equal(value, UNHASHED_CACHE, rel);
    assert.doesNotMatch(value, /immutable|31536000/, rel);
  }
  assert.match(staticCacheControl('sw.js'), /max-age=0/);
});

test('every static response has explicit Content-Type, Cache-Control and nosniff', () => {
  for (const rel of ['ads.txt', 'favicon.ico', 'assets/a.js', 'weird.bin', 'sw.js']) {
    const headers = staticHeadersFor(rel);
    assert.ok(headers['Content-Type'], rel);
    assert.ok(headers['Cache-Control'], rel);
    assert.equal(headers['X-Content-Type-Options'], 'nosniff', rel);
  }
  assert.equal(staticHeadersFor('assets/font.woff2')['Access-Control-Allow-Origin'], '*');
  assert.equal(staticHeadersFor('symbols/ntoskrnl.json')['Access-Control-Allow-Origin'], '*');
  assert.equal(staticHeadersFor('ads.txt')['Access-Control-Allow-Origin'], undefined);
});

test('security.txt lives under /.well-known/ with RFC 9116 Contact and Expires', () => {
  assert.equal(STATIC_REDIRECTS['/security.txt'], '/.well-known/security.txt');
  const file = new URL('../public/.well-known/security.txt', import.meta.url);
  assert.ok(fs.existsSync(file), 'public/.well-known/security.txt exists');
  assert.ok(!fs.existsSync(new URL('../public/security.txt', import.meta.url)), 'no second copy at the root');
  const text = fs.readFileSync(file, 'utf8');
  const field = (name) => text.split(/\r?\n/)
    .map(line => line.match(new RegExp(`^${name}:\\s*(.+)$`, 'i')))
    .filter(Boolean).map(m => m[1].trim());
  assert.ok(field('Contact').length >= 1, 'Contact field');
  for (const contact of field('Contact')) assert.match(contact, /^(mailto:|https:\/\/)/);
  const expires = field('Expires');
  assert.equal(expires.length, 1, 'exactly one Expires field');
  assert.match(expires[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  assert.ok(!Number.isNaN(Date.parse(expires[0])));
});
