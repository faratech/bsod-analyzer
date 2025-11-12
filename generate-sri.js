#!/usr/bin/env node
/**
 * Generate SRI (Subresource Integrity) hashes for all built assets
 * Run after build: node generate-sri.js
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DIST_DIR = path.join(__dirname, 'dist');
const ASSETS_DIR = path.join(DIST_DIR, 'assets');
const SRI_OUTPUT = path.join(DIST_DIR, 'sri-mapping.json');
const INDEX_HTML = path.join(DIST_DIR, 'index.html');

/**
 * Generate SHA-384 hash for a file
 */
function generateSRI(filePath) {
  const content = fs.readFileSync(filePath);
  const hash = crypto.createHash('sha384').update(content).digest('base64');
  return `sha384-${hash}`;
}

/**
 * Find all JavaScript and CSS files in assets directory
 */
function findAssets() {
  const assets = {};

  if (!fs.existsSync(ASSETS_DIR)) {
    console.error('Assets directory not found:', ASSETS_DIR);
    return assets;
  }

  const files = fs.readdirSync(ASSETS_DIR);

  for (const file of files) {
    if (file.endsWith('.js') || file.endsWith('.css')) {
      const filePath = path.join(ASSETS_DIR, file);
      const sri = generateSRI(filePath);
      assets[file] = sri;
      console.log(`✓ ${file}: ${sri}`);
    }
  }

  return assets;
}

/**
 * Update index.html with integrity attributes
 */
function updateIndexHTML(sriMapping) {
  if (!fs.existsSync(INDEX_HTML)) {
    console.error('index.html not found');
    return;
  }

  let html = fs.readFileSync(INDEX_HTML, 'utf8');
  let updated = false;

  // Update script tags with integrity
  for (const [filename, hash] of Object.entries(sriMapping)) {
    if (filename.endsWith('.js')) {
      // Match script tags with this file
      const scriptRegex = new RegExp(
        `(<script[^>]*src=["']/assets/${filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*)(>)`,
        'g'
      );

      html = html.replace(scriptRegex, (match, before, after) => {
        // Check if integrity already exists
        if (before.includes('integrity=')) {
          // Update existing integrity
          const newBefore = before.replace(/integrity=["'][^"']*["']/, `integrity="${hash}"`);
          updated = true;
          return newBefore + after;
        } else {
          // Add integrity attribute
          updated = true;
          return `${before} integrity="${hash}" crossorigin${after}`;
        }
      });

      // Match modulepreload links
      const preloadRegex = new RegExp(
        `(<link[^>]*rel=["']modulepreload["'][^>]*href=["']/assets/${filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*)(>)`,
        'g'
      );

      html = html.replace(preloadRegex, (match, before, after) => {
        // Check if integrity already exists
        if (before.includes('integrity=')) {
          // Update existing integrity
          const newBefore = before.replace(/integrity=["'][^"']*["']/, `integrity="${hash}"`);
          updated = true;
          return newBefore + after;
        } else {
          // Add integrity attribute
          updated = true;
          return `${before} integrity="${hash}" crossorigin${after}`;
        }
      });
    } else if (filename.endsWith('.css')) {
      // Match CSS link tags
      const cssRegex = new RegExp(
        `(<link[^>]*href=["']/assets/${filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*)(>)`,
        'g'
      );

      html = html.replace(cssRegex, (match, before, after) => {
        if (before.includes('integrity=')) {
          const newBefore = before.replace(/integrity=["'][^"']*["']/, `integrity="${hash}"`);
          updated = true;
          return newBefore + after;
        } else {
          updated = true;
          return `${before} integrity="${hash}" crossorigin${after}`;
        }
      });
    }
  }

  if (updated) {
    fs.writeFileSync(INDEX_HTML, html);
    console.log('\n✓ Updated index.html with integrity attributes');
  }
}

/**
 * Main execution
 */
function main() {
  console.log('🔐 Generating SRI hashes for assets...\n');

  // Generate SRI hashes
  const sriMapping = findAssets();

  if (Object.keys(sriMapping).length === 0) {
    console.error('\n❌ No assets found to hash');
    process.exit(1);
  }

  // Save SRI mapping
  fs.writeFileSync(SRI_OUTPUT, JSON.stringify(sriMapping, null, 2));
  console.log(`\n✓ SRI mapping saved to: ${SRI_OUTPUT}`);
  console.log(`   ${Object.keys(sriMapping).length} files hashed`);

  // Update index.html
  updateIndexHTML(sriMapping);

  console.log('\n✅ SRI generation complete!');
  console.log('\n📋 Next steps:');
  console.log('   1. Verify integrity attributes in dist/index.html');
  console.log('   2. Update CSP headers to enforce script hashes');
  console.log('   3. Deploy updated files to Cloud Run');
}

main();
