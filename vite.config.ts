import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import { config } from './config.js';

export default defineConfig(({ mode }) => {
    loadEnv(mode, '.', '');
    const buildTimestamp = Math.floor(Date.now() / 1000); // Unix timestamp
    const now = new Date();
    const buildVersion = `v${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}-${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}`;

    // Cache-bust favicon, icons, and manifest references
    const cacheBustAssets = (html: string) => html
        .replace(/href="\/favicon(-\d+x\d+)?\.webp"/g,
            (_match, size) => `href="/favicon${size || ''}.webp?v=${buildTimestamp}"`)
        .replace('href="/favicon.ico"',
            `href="/favicon.ico?v=${buildTimestamp}"`)
        .replace('href="/apple-touch-icon.webp"',
            `href="/apple-touch-icon.webp?v=${buildTimestamp}"`)
        .replace(/href="\/android-chrome-(\d+x\d+)\.webp"/g,
            (_match, size) => `href="/android-chrome-${size}.webp?v=${buildTimestamp}"`)
        .replace('href="/site.webmanifest"',
            `href="/site.webmanifest?v=${buildTimestamp}"`);

    return {
      define: {
        '__BUILD_TIMESTAMP__': buildTimestamp,
        '__BUILD_VERSION__': JSON.stringify(buildVersion),
        // Baked at build time so the Footer year is identical in the prerendered
        // HTML and the client bundle (avoids a hydration mismatch).
        '__BUILD_YEAR__': now.getUTCFullYear(),
        // WindowsForum SSO + premium upgrade master switch (default OFF so the
        // feature ships dormant and invisible until WF_SSO_ENABLED=true at build).
        '__WF_SSO_ENABLED__': process.env.WF_SSO_ENABLED === 'true'
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      },
      build: {
        // Enable minification and compression
        minify: 'terser',
        terserOptions: {
          compress: {
            drop_console: false, // Keep console for debugging
            drop_debugger: true
          },
          mangle: {
            keep_fnames: true // Keep function names to help debug
          }
        },
        // Asset optimization
        // Inline small images/fonts up to 4KB, but never inline CSS: inlining CSS
        // as a data:text/css URL defeats the media="print" onload defer pattern and
        // forces 'data:' into the CSP style-src.
        assetsInlineLimit: (filePath: string) => filePath.endsWith('.css') ? false : undefined,
        cssCodeSplit: true, // Split CSS into separate chunks
        rollupOptions: {
          output: {
            // Manual chunk splitting for better caching
            manualChunks(id) {
              if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/')) {
                return 'react-vendor';
              }
            }
          }
        }
      },
      plugins: [
        {
          name: 'inject-config-and-cache-bust',
          transformIndexHtml(html) {
            // Replace config placeholders with actual values
            html = html
              .replace(
                'window.__ADS_ENABLED__ = true;',
                `window.__ADS_ENABLED__ = ${config.ads.enabled};`
              )
              .replace(
                'window.__ANALYTICS_ENABLED__ = true;',
                `window.__ANALYTICS_ENABLED__ = ${config.analytics.enabled};`
              )
              .replace(
                "window.__GA_ID__ = 'G-0HVHB49RDP';",
                `window.__GA_ID__ = '${config.analytics.gaId}';`
              );

            return cacheBustAssets(html);
          }
        },
        {
          name: 'generate-service-worker',
          generateBundle() {
            this.emitFile({
              type: 'asset',
              fileName: 'sw.js',
              source: [
                `const BUILD_VERSION = '${buildTimestamp}';`,
                `const CACHE_NAME = 'bsod-v' + BUILD_VERSION;`,
                ``,
                `self.addEventListener('install', () => self.skipWaiting());`,
                ``,
                `self.addEventListener('activate', (event) => {`,
                `  event.waitUntil(`,
                `    caches.keys()`,
                `      .then((names) => Promise.all(`,
                `        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))`,
                `      ))`,
                `      .then(() => self.clients.claim())`,
                `  );`,
                `});`,
                ``,
                `self.addEventListener('fetch', (event) => {`,
                `  if (event.request.mode === 'navigate') {`,
                `    event.respondWith(`,
                `      fetch(event.request)`,
                `        .then((res) => {`,
                `          const clone = res.clone();`,
                `          caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));`,
                `          return res;`,
                `        })`,
                `        .catch(() => caches.match(event.request))`,
                `    );`,
                `  }`,
                `});`,
              ].join('\n')
            });
          }
        },
      ]
    };
});
