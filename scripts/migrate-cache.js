#!/usr/bin/env node
/**
 * Cache Migration Script
 *
 * Migrates legacy cache keys (windbg: and ai-report:) to the new combined format (analysis:)
 *
 * Usage:
 *   node scripts/migrate-cache.js [--dry-run] [--delete-old]
 *
 * Options:
 *   --dry-run     Show what would be migrated without making changes
 *   --delete-old  Delete old keys after successful migration
 */

import { Redis } from '@upstash/redis';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: '.env.local' });
dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');
const DELETE_OLD = process.argv.includes('--delete-old');

// Cache key prefixes
const PREFIX = {
  ANALYSIS: 'analysis',
  WINDBG: 'windbg',
  AI_REPORT: 'ai-report'
};

async function main() {
  console.log('='.repeat(60));
  console.log('Cache Migration Script');
  console.log('='.repeat(60));
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE'}`);
  console.log(`Delete old keys: ${DELETE_OLD ? 'YES' : 'NO'}`);
  console.log('');

  // Initialize Redis
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    console.error('ERROR: Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
    console.error('Set these in .env.local or environment');
    process.exit(1);
  }

  const redis = new Redis({ url, token });
  console.log('Connected to Upstash Redis\n');

  // Scan for all keys
  console.log('Scanning for existing keys...\n');

  const windbgKeys = new Map();
  const aiReportKeys = new Map();
  const analysisKeys = new Set();

  let cursor = 0;
  let scanCount = 0;

  do {
    const result = await redis.scan(cursor, { count: 1000 });
    const nextCursor = result[0];
    const keys = result[1];
    cursor = typeof nextCursor === 'string' ? parseInt(nextCursor) : nextCursor;
    scanCount += keys.length;

    if (scanCount % 500 === 0) {
      console.log(`  Scanned ${scanCount} keys so far...`);
    }

    for (const key of keys) {
      if (key.startsWith(`${PREFIX.WINDBG}:`)) {
        const hash = key.replace(`${PREFIX.WINDBG}:`, '');
        windbgKeys.set(hash, key);
      } else if (key.startsWith(`${PREFIX.AI_REPORT}:`)) {
        const hash = key.replace(`${PREFIX.AI_REPORT}:`, '');
        aiReportKeys.set(hash, key);
      } else if (key.startsWith(`${PREFIX.ANALYSIS}:`)) {
        const hash = key.replace(`${PREFIX.ANALYSIS}:`, '');
        analysisKeys.add(hash);
      }
    }
  } while (cursor !== 0);

  console.log(`Scanned ${scanCount} total keys`);
  console.log(`  - ${windbgKeys.size} windbg: keys`);
  console.log(`  - ${aiReportKeys.size} ai-report: keys`);
  console.log(`  - ${analysisKeys.size} analysis: keys (already migrated)`);
  console.log('');

  // Find unique file hashes that need migration
  const allHashes = new Set([...windbgKeys.keys(), ...aiReportKeys.keys()]);
  const hashesToMigrate = [...allHashes].filter(hash => !analysisKeys.has(hash));

  console.log(`Found ${hashesToMigrate.length} hashes to migrate\n`);

  if (hashesToMigrate.length === 0) {
    console.log('Nothing to migrate. All data is already in the new format.');
    process.exit(0);
  }

  // Migrate each hash
  let migrated = 0;
  let skipped = 0;
  let errors = 0;
  const keysToDelete = [];

  for (const hash of hashesToMigrate) {
    const shortHash = hash.substring(0, 12) + '...';

    try {
      // Fetch existing data
      const windbgKey = windbgKeys.get(hash);
      const aiReportKey = aiReportKeys.get(hash);

      let windbgData = null;
      let aiReportData = null;

      if (windbgKey) {
        const raw = await redis.get(windbgKey);
        windbgData = typeof raw === 'string' ? JSON.parse(raw) : raw;
      }

      if (aiReportKey) {
        const raw = await redis.get(aiReportKey);
        aiReportData = typeof raw === 'string' ? JSON.parse(raw) : raw;
      }

      // Skip if no data found
      if (!windbgData && !aiReportData) {
        console.log(`  [SKIP] ${shortHash} - No data found`);
        skipped++;
        continue;
      }

      // Create combined analysis object
      const analysisData = {
        windbgOutput: windbgData?.windbgOutput || null,
        aiReport: aiReportData || null,
        timestamp: windbgData?.timestamp || Date.now(),
        migratedAt: Date.now()
      };

      const analysisKey = `${PREFIX.ANALYSIS}:${hash}`;

      if (DRY_RUN) {
        console.log(`  [DRY] Would migrate ${shortHash}`);
        console.log(`        - windbg: ${windbgData ? 'YES' : 'NO'}`);
        console.log(`        - ai-report: ${aiReportData ? 'YES' : 'NO'}`);
      } else {
        // Write combined data
        await redis.set(analysisKey, JSON.stringify(analysisData));
        console.log(`  [OK] Migrated ${shortHash}`);

        // Track keys for deletion
        if (windbgKey) keysToDelete.push(windbgKey);
        if (aiReportKey) keysToDelete.push(aiReportKey);
      }

      migrated++;
    } catch (error) {
      console.error(`  [ERR] Failed to migrate ${shortHash}: ${error.message}`);
      errors++;
    }
  }

  console.log('');
  console.log('-'.repeat(60));
  console.log(`Migration complete:`);
  console.log(`  - Migrated: ${migrated}`);
  console.log(`  - Skipped: ${skipped}`);
  console.log(`  - Errors: ${errors}`);

  // Delete old keys if requested
  if (DELETE_OLD && !DRY_RUN && keysToDelete.length > 0) {
    console.log('');
    console.log(`Deleting ${keysToDelete.length} old keys...`);

    // Delete in batches
    const BATCH_SIZE = 50;
    for (let i = 0; i < keysToDelete.length; i += BATCH_SIZE) {
      const batch = keysToDelete.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(key => redis.del(key)));
      console.log(`  Deleted ${Math.min(i + BATCH_SIZE, keysToDelete.length)}/${keysToDelete.length}`);
    }

    console.log('Old keys deleted.');
  } else if (DELETE_OLD && DRY_RUN) {
    console.log('');
    console.log(`[DRY] Would delete ${keysToDelete.length} old keys`);
  }

  console.log('');
  console.log('Done!');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
