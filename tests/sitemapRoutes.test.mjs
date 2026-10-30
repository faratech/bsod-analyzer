import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rolldown } from 'rolldown';

// Every indexable page the router serves must be in the sitemap and have a
// proper breadcrumb label (issue #302: /privacy had neither).
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const ORIGIN = 'https://bsod.windowsforum.com';

// Routes rendered with noindex (or the catch-all) are not listed.
const NOT_INDEXED = new Set(['*', '/stats/embed']);
const routes = [...read('AppRouter.tsx').matchAll(/<Route path="([^"]+)"/g)]
  .map(match => match[1])
  .filter(route => !NOT_INDEXED.has(route));

// useBreadcrumbs only reads useLocation(), so it runs as a plain function with
// react-router-dom replaced by a stub that returns the location under test.
async function loadBreadcrumbs() {
  const harness = `
import { useBreadcrumbs } from ${JSON.stringify(path.join(root, 'hooks', 'useBreadcrumbs.tsx'))};
export function breadcrumbsFor(pathname) {
  globalThis.__breadcrumbPath = pathname;
  return useBreadcrumbs();
}
`;
  const virtual = {
    harness,
    'react-router-dom': 'export const useLocation = () => ({ pathname: globalThis.__breadcrumbPath });',
  };
  const bundle = await rolldown({
    input: 'harness',
    platform: 'neutral',
    logLevel: 'silent',
    plugins: [{
      name: 'harness',
      resolveId: id => (id in virtual ? id : null),
      load: id => (id in virtual ? virtual[id] : null),
    }],
  });
  const { output } = await bundle.generate({ format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(output[0].code, 'utf8').toString('base64')}`);
}

test('the router serves /privacy (sanity for the checks below)', () => {
  assert.ok(routes.includes('/privacy'));
  assert.ok(routes.length >= 6);
});

test('every indexable route is listed in public/sitemap.xml (issue #302)', () => {
  const sitemap = read('public', 'sitemap.xml');
  const locs = new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]));
  for (const route of routes) {
    assert.ok(locs.has(route === '/' ? `${ORIGIN}/` : `${ORIGIN}${route}`), `${route} is in the sitemap`);
  }
});

test('every indexable route has a breadcrumb label, not its raw path segment (issue #302)', async () => {
  const { breadcrumbsFor } = await loadBreadcrumbs();
  for (const route of routes.filter(r => r !== '/')) {
    const items = breadcrumbsFor(route).itemListElement;
    const last = items[items.length - 1];
    assert.equal(last.item, `${ORIGIN}${route}`);
    assert.notEqual(last.name, route.split('/').pop(), `${route} has a label`);
  }
  const privacy = breadcrumbsFor('/privacy').itemListElement;
  assert.equal(privacy[privacy.length - 1].name, 'Privacy');
});

test('robots.txt lists every indexable route it singles out (issue #302)', () => {
  const allowed = new Set([...read('public', 'robots.txt').matchAll(/^Allow:\s*(\S+)/gm)].map(match => match[1]));
  for (const route of routes.filter(r => r !== '/')) {
    assert.ok(allowed.has(route), `robots.txt allows ${route}`);
  }
});
