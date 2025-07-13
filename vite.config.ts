import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import { copyFile, mkdir } from 'fs/promises';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
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
            drop_console: true, // Remove console.log in production
            drop_debugger: true
          }
        },
        // Asset optimization
        assetsInlineLimit: 4096, // Inline assets smaller than 4kb
        cssCodeSplit: true, // Split CSS into separate chunks
        rollupOptions: {
          output: {
            // Manual chunk splitting for better caching
            manualChunks: {
              'react-vendor': ['react', 'react-dom'],
              'ui-vendor': ['react-markdown', 'remark-gfm']
            }
          }
        }
      },
      plugins: [
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
                await copyFile(file, `dist/${file}`);
                console.log(`✓ Copied ${file} to dist/`);
              } catch (err) {
                console.warn(`⚠ Failed to copy ${file}:`, err.message);
              }
            }
          }
        }
      ]
    };
});
