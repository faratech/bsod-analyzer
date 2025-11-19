#!/usr/bin/env node

/**
 * Gemini API Cost Calculator for BSOD Analyzer
 *
 * Pricing as of Nov 2025:
 * - Gemini 3 Pro: $2.00 per 1M input tokens, $12.00 per 1M output tokens (≤200K context)
 * - Grounding: $35 per 1000 grounded queries (only for advanced tools)
 */

// Average token counts based on typical BSOD analysis
const AVERAGE_TOKENS = {
  // Initial analysis (no grounding)
  initialAnalysis: {
    input: {
      prompt: 1500,           // Base prompt template
      hexDump: 2000,          // 1KB hex dump
      extractedStrings: 15000 // ~25KB of strings
    },
    output: 800               // JSON response with analysis
  },
  
  // Advanced analysis tools (with grounding)
  advancedTool: {
    input: {
      prompt: 800,
      hexDump: 2000,
      extractedStrings: 15000,
      context: 500            // Previous analysis context
    },
    output: 1200              // Detailed text output
  }
};

// Pricing per 1M tokens (Gemini 3 Pro) - Updated Nov 2025
const PRICING = {
  inputTokens: 2.00,    // $2.00 per 1M input tokens (≤200K context)
  outputTokens: 12.00,  // $12.00 per 1M output tokens (≤200K context)
  grounding: 35.0       // $35 per 1000 grounded queries
};

function calculateInitialAnalysisCost(numFiles = 1) {
  const inputTokens = Object.values(AVERAGE_TOKENS.initialAnalysis.input)
    .reduce((sum, val) => sum + val, 0) * numFiles;
  const outputTokens = AVERAGE_TOKENS.initialAnalysis.output * numFiles;
  
  const inputCost = (inputTokens / 1_000_000) * PRICING.inputTokens;
  const outputCost = (outputTokens / 1_000_000) * PRICING.outputTokens;
  
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
    groundingCost: 0
  };
}

function calculateAdvancedToolCost(numTools = 1) {
  const inputTokens = Object.values(AVERAGE_TOKENS.advancedTool.input)
    .reduce((sum, val) => sum + val, 0) * numTools;
  const outputTokens = AVERAGE_TOKENS.advancedTool.output * numTools;
  
  const inputCost = (inputTokens / 1_000_000) * PRICING.inputTokens;
  const outputCost = (outputTokens / 1_000_000) * PRICING.outputTokens;
  const groundingCost = (numTools / 1000) * PRICING.grounding;
  
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    inputCost,
    outputCost,
    groundingCost,
    totalCost: inputCost + outputCost + groundingCost
  };
}

function formatCurrency(amount) {
  return `$${amount.toFixed(6)}`;
}

function printCostBreakdown(title, costData) {
  console.log(`\n${title}`);
  console.log('='.repeat(50));
  console.log(`Input tokens:    ${costData.inputTokens.toLocaleString()} (${formatCurrency(costData.inputCost)})`);
  console.log(`Output tokens:   ${costData.outputTokens.toLocaleString()} (${formatCurrency(costData.outputCost)})`);
  console.log(`Total tokens:    ${costData.totalTokens.toLocaleString()}`);
  if (costData.groundingCost > 0) {
    console.log(`Grounding cost:  ${formatCurrency(costData.groundingCost)}`);
  }
  console.log(`TOTAL COST:      ${formatCurrency(costData.totalCost)}`);
}

// Main calculation
console.log('BSOD Analyzer - Gemini API Cost Calculator');
console.log('==========================================');
console.log(`\nPricing (Gemini 3 Pro):`);
console.log(`- Input:     $${PRICING.inputTokens} per 1M tokens`);
console.log(`- Output:    $${PRICING.outputTokens} per 1M tokens`);
console.log(`- Grounding: $${PRICING.grounding} per 1000 queries`);

// Single minidump analysis
const singleDump = calculateInitialAnalysisCost(1);
printCostBreakdown('Single Minidump Analysis', singleDump);

// 5 minidumps analysis
const fiveDumps = calculateInitialAnalysisCost(5);
printCostBreakdown('5 Minidumps Analysis (batch)', fiveDumps);

// Advanced analysis example (4 tools per dump)
console.log('\n\nAdvanced Analysis Example (per minidump):');
console.log('User runs all 4 advanced tools: !analyze -v, lm kv, !process 0 0, !vm');
const advancedAnalysis = calculateAdvancedToolCost(4);
printCostBreakdown('4 Advanced Tools', advancedAnalysis);

// Complete session example
console.log('\n\nTypical Complete Session:');
console.log('5 minidumps + 2 advanced tools on the most critical dump');
const sessionInitial = calculateInitialAnalysisCost(5);
const sessionAdvanced = calculateAdvancedToolCost(2);
const sessionTotal = {
  inputTokens: sessionInitial.inputTokens + sessionAdvanced.inputTokens,
  outputTokens: sessionInitial.outputTokens + sessionAdvanced.outputTokens,
  totalTokens: sessionInitial.totalTokens + sessionAdvanced.totalTokens,
  inputCost: sessionInitial.inputCost + sessionAdvanced.inputCost,
  outputCost: sessionInitial.outputCost + sessionAdvanced.outputCost,
  groundingCost: sessionAdvanced.groundingCost,
  totalCost: sessionInitial.totalCost + sessionAdvanced.totalCost
};
printCostBreakdown('Complete Session Total', sessionTotal);

// Monthly projections
console.log('\n\nMonthly Projections:');
console.log('='.repeat(50));
const usageScenarios = [
  { name: 'Light (10 dumps/month)', dumps: 10, advancedPercent: 0.2 },
  { name: 'Medium (100 dumps/month)', dumps: 100, advancedPercent: 0.15 },
  { name: 'Heavy (1000 dumps/month)', dumps: 1000, advancedPercent: 0.1 }
];

usageScenarios.forEach(scenario => {
  const initialCost = calculateInitialAnalysisCost(scenario.dumps);
  const advancedCost = calculateAdvancedToolCost(Math.floor(scenario.dumps * scenario.advancedPercent * 2)); // 2 tools per analyzed dump
  const totalMonthly = initialCost.totalCost + advancedCost.totalCost;
  
  console.log(`\n${scenario.name}:`);
  console.log(`  Initial analyses: ${formatCurrency(initialCost.totalCost)}`);
  console.log(`  Advanced tools:   ${formatCurrency(advancedCost.totalCost)}`);
  console.log(`  Monthly total:    ${formatCurrency(totalMonthly)}`);
  console.log(`  Per dump avg:     ${formatCurrency(totalMonthly / scenario.dumps)}`);
});

console.log('\n\nNotes:');
console.log('- Token counts are estimates based on typical BSOD dump analysis');
console.log('- Actual costs may vary based on dump file complexity');
console.log('- Grounding is only used for advanced debugging tools');
console.log('- Prices current as of November 2025');