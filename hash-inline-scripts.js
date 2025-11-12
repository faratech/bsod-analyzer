#!/usr/bin/env node
/**
 * Generate SHA-256 hashes for inline scripts in index.html
 * Used for CSP script-src directive
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const INDEX_HTML = path.join(__dirname, 'dist', 'index.html');

/**
 * Generate SHA-256 hash for inline script content
 */
function generateScriptHash(content) {
  const hash = crypto.createHash('sha256').update(content).digest('base64');
  return `'sha256-${hash}'`;
}

/**
 * Extract inline scripts from HTML
 */
function extractInlineScripts(html) {
  const scripts = [];
  const scriptRegex = /<script>([\s\S]*?)<\/script>/g;
  let match;

  while ((match = scriptRegex.exec(html)) !== null) {
    const content = match[1];

    // Skip JSON-LD scripts
    if (content.trim().startsWith('{')) {
      continue;
    }

    scripts.push(content);
  }

  return scripts;
}

/**
 * Main execution
 */
function main() {
  console.log('🔐 Generating hashes for inline scripts...\n');

  if (!fs.existsSync(INDEX_HTML)) {
    console.error('❌ index.html not found');
    process.exit(1);
  }

  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const scripts = extractInlineScripts(html);

  if (scripts.length === 0) {
    console.log('✓ No inline scripts found');
    return;
  }

  console.log(`Found ${scripts.length} inline script(s):\n`);

  const hashes = [];
  scripts.forEach((script, index) => {
    const hash = generateScriptHash(script);
    hashes.push(hash);

    const preview = script.trim().substring(0, 80).replace(/\n/g, ' ');
    console.log(`Script ${index + 1}:`);
    console.log(`  Preview: ${preview}...`);
    console.log(`  Hash: ${hash}`);
    console.log('');
  });

  console.log('📋 CSP script-src directive (add these hashes):');
  console.log('');
  console.log(`script-src 'self' ${hashes.join(' ')} https://*.cloudflare.com https://*.google.com https://*.googleapis.com https://*.googlesyndication.com https://*.doubleclick.net https://*.googletagmanager.com https://*.google-analytics.com https://*.gstatic.com;`);
  console.log('');

  console.log('✅ Add these hashes to your CSP in server.js');
  console.log('   Remove \'unsafe-inline\' and \'unsafe-eval\' after adding hashes');

  // Save hashes to file for reference
  const hashesFile = path.join(__dirname, 'inline-script-hashes.json');
  fs.writeFileSync(hashesFile, JSON.stringify({
    hashes,
    generated: new Date().toISOString(),
    cspDirective: `script-src 'self' ${hashes.join(' ')}`
  }, null, 2));

  console.log(`\n💾 Hashes saved to: ${hashesFile}`);
}

main();
