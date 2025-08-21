#!/usr/bin/env node

import { PurgeCSS } from 'purgecss';
import fs from 'fs';
import path from 'path';

const APPLY_FLAG = process.argv.includes('--apply');

async function analyzeCSSUsage() {
  console.log('🔍 Analyzing CSS usage...\n');

  const purgeCSSResult = await new PurgeCSS().purge({
    content: [
      './index.html',
      './src/**/*.{js,ts,jsx,tsx}',
      './components/**/*.{js,ts,jsx,tsx}',
      './pages/**/*.{js,ts,jsx,tsx}',
      './amp/**/*.html'
    ],
    css: ['./styles.css'],
    defaultExtractor: content => content.match(/[\w-/:]+(?<!:)/g) || [],
    safelist: {
      standard: [
        // AdSense classes
        'adsbygoogle',
        'ad-container', 
        'sticky-ad',
        // Animation classes
        'fade-in',
        'expanded',
        'copying',
        'copied',
        // Status classes
        /^status-/,
        /^result-/,
        // Dynamic classes
        /^binary-/,
        /^hero-/,
        // React Router classes
        'active',
        'pending',
        // Brand colors
        /^text-brand/,
        /^bg-brand/,
        /^border-brand/,
        // Utility classes
        'w-5', 'h-5', 'w-6', 'h-6',
        'text-center', 'mt-2'
      ],
      deep: [
        // React-markdown generated classes
        /^code/,
        /^pre/,
        // Dynamic state classes
        /data-/,
        /aria-/
      ]
    },
    rejected: true
  });

  const originalSize = fs.statSync('./styles.css').size;
  const purgedSize = Buffer.byteLength(purgeCSSResult[0].css, 'utf8');
  const rejectedSelectors = purgeCSSResult[0].rejected || [];
  
  console.log('📊 CSS Analysis Results:');
  console.log('========================');
  console.log(`Original CSS size: ${(originalSize / 1024).toFixed(2)} KB`);
  console.log(`Purged CSS size: ${(purgedSize / 1024).toFixed(2)} KB`);
  console.log(`Reduction: ${(((originalSize - purgedSize) / originalSize) * 100).toFixed(1)}%`);
  console.log(`Bytes saved: ${(originalSize - purgedSize).toLocaleString()} bytes\n`);

  if (rejectedSelectors.length > 0) {
    console.log('🗑️  Unused CSS selectors found:');
    console.log('==============================');
    rejectedSelectors.slice(0, 20).forEach(selector => {
      console.log(`  - ${selector}`);
    });
    
    if (rejectedSelectors.length > 20) {
      console.log(`  ... and ${rejectedSelectors.length - 20} more`);
    }
    
    console.log(`\n💡 Total unused selectors: ${rejectedSelectors.length}`);
    
    // Write full report to file
    const reportPath = './css-analysis-report.txt';
    const report = [
      'CSS Analysis Report',
      '==================',
      `Generated: ${new Date().toISOString()}`,
      `Original size: ${(originalSize / 1024).toFixed(2)} KB`,
      `Purged size: ${(purgedSize / 1024).toFixed(2)} KB`,
      `Reduction: ${(((originalSize - purgedSize) / originalSize) * 100).toFixed(1)}%`,
      '',
      'Unused CSS Selectors:',
      '--------------------',
      ...rejectedSelectors.map(selector => `- ${selector}`)
    ].join('\n');
    
    fs.writeFileSync(reportPath, report);
    console.log(`\n📄 Full report saved to: ${reportPath}`);
    
    // Save purged CSS
    fs.writeFileSync('./styles.purged.css', purgeCSSResult[0].css);
    console.log(`💾 Purged CSS saved to: ./styles.purged.css`);
    
    // Apply changes if --apply flag is used
    if (APPLY_FLAG) {
      console.log('\n🚀 Applying optimizations...');
      
      // Backup original
      const timestamp = new Date().toISOString().replace(/[:]/g, '-').split('.')[0];
      fs.copyFileSync('./styles.css', `./styles.backup-${timestamp}.css`);
      console.log(`📋 Backup created: styles.backup-${timestamp}.css`);
      
      // Apply purged CSS
      fs.writeFileSync('./styles.css', purgeCSSResult[0].css);
      console.log('✅ Optimized CSS applied to styles.css');
      console.log(`💾 Saved ${(originalSize - purgedSize).toLocaleString()} bytes!`);
    } else {
      console.log('\n💡 To apply these optimizations, run:');
      console.log('   npm run analyze-css -- --apply');
      console.log('\n⚠️  This will backup your current styles.css and replace it with the optimized version.');
    }
  } else {
    console.log('✅ No unused CSS found! Your styles are already optimized.');
  }
}

analyzeCSSUsage().catch(console.error);