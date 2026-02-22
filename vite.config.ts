import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import { copyFile, mkdir, readFile, writeFile } from 'fs/promises';
import { config } from './config.js';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
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
        '__BUILD_VERSION__': JSON.stringify(buildVersion)
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
        assetsInlineLimit: 4096, // Inline assets smaller than 4kb
        cssCodeSplit: true, // Split CSS into separate chunks
        rollupOptions: {
          output: {
            // Manual chunk splitting for better caching
            // react-markdown/remark-gfm excluded: they're only used in lazy-loaded
            // Documentation/About pages and will be code-split automatically
            manualChunks: {
              'react-vendor': ['react', 'react-dom']
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
          name: 'copy-amp-files',
          writeBundle: async () => {
            // Ensure amp directory exists in dist
            await mkdir('dist/amp', { recursive: true });
            
            // Copy AMP files to dist directory
            const ampFiles = [
              'amp/index.html',
              'amp/about.html', 
              'amp/documentation.html',
              'amp/donate.html',
              'amp/sitemap.xml'
            ];
            
            for (const file of ampFiles) {
              try {
                if (file.endsWith('.html')) {
                  const content = cacheBustAssets(await readFile(file, 'utf-8'));
                  await writeFile(`dist/${file}`, content, 'utf-8');
                  console.log(`✓ Copied and cache-busted ${file} to dist/`);
                } else {
                  // Just copy non-HTML files
                  await copyFile(file, `dist/${file}`);
                  console.log(`✓ Copied ${file} to dist/`);
                }
              } catch (err) {
                console.warn(`⚠ Failed to copy ${file}:`, err.message);
              }
            }
          }
        }
      ]
    };
});
