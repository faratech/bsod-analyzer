#!/usr/bin/env node

/**
 * Interactive Gemini API Cost Calculator for BSOD Analyzer
 * Usage: node calculate-cost-interactive.js [dumps] [advanced_tools]
 */

const PRICING = {
  inputTokensPerM: 0.30,    // Updated Dec 2024 pricing
  outputTokensPerM: 2.50,   // Updated Dec 2024 pricing
  groundingPer1K: 35.0
};

const TOKENS = {
  initial: { input: 18500, output: 800 },
  advanced: { input: 18300, output: 1200 }
};

function calculateCost(numDumps, numAdvancedTools) {
  // Initial analysis cost (no grounding)
  const initialInput = (numDumps * TOKENS.initial.input / 1_000_000) * PRICING.inputTokensPerM;
  const initialOutput = (numDumps * TOKENS.initial.output / 1_000_000) * PRICING.outputTokensPerM;
  const initialTotal = initialInput + initialOutput;
  
  // Advanced tools cost (with grounding)
  const advancedInput = (numAdvancedTools * TOKENS.advanced.input / 1_000_000) * PRICING.inputTokensPerM;
  const advancedOutput = (numAdvancedTools * TOKENS.advanced.output / 1_000_000) * PRICING.outputTokensPerM;
  const groundingCost = (numAdvancedTools / 1000) * PRICING.groundingPer1K;
  const advancedTotal = advancedInput + advancedOutput + groundingCost;
  
  return {
    dumps: numDumps,
    tools: numAdvancedTools,
    initialCost: initialTotal,
    advancedCost: advancedTotal,
    totalCost: initialTotal + advancedTotal,
    breakdown: {
      initialTokens: numDumps * (TOKENS.initial.input + TOKENS.initial.output),
      advancedTokens: numAdvancedTools * (TOKENS.advanced.input + TOKENS.advanced.output),
      totalTokens: numDumps * (TOKENS.initial.input + TOKENS.initial.output) + 
                   numAdvancedTools * (TOKENS.advanced.input + TOKENS.advanced.output)
    }
  };
}

// Parse command line arguments
const args = process.argv.slice(2);
const numDumps = parseInt(args[0]) || 1;
const numAdvancedTools = parseInt(args[1]) || 0;

// Calculate costs
const result = calculateCost(numDumps, numAdvancedTools);

// Display results
console.log('\n🔵 BSOD Analyzer Cost Estimate');
console.log('━'.repeat(40));
console.log(`📊 Analysis: ${result.dumps} minidump${result.dumps > 1 ? 's' : ''}`);
if (result.tools > 0) {
  console.log(`🔧 Advanced tools: ${result.tools} query${result.tools > 1 ? 'ies' : 'y'}`);
}
console.log('━'.repeat(40));
console.log(`Initial analysis:  $${result.initialCost.toFixed(4)}`);
if (result.tools > 0) {
  console.log(`Advanced tools:    $${result.advancedCost.toFixed(4)}`);
}
console.log(`\n💰 TOTAL COST:     $${result.totalCost.toFixed(4)}`);
console.log(`📈 Per dump avg:   $${(result.totalCost / result.dumps).toFixed(4)}`);
console.log(`🔤 Total tokens:   ${result.breakdown.totalTokens.toLocaleString()}`);

// Show examples if no arguments provided
if (args.length === 0) {
  console.log('\n📌 Usage Examples:');
  console.log('  node calculate-cost-interactive.js 1        # 1 dump, no advanced tools');
  console.log('  node calculate-cost-interactive.js 5        # 5 dumps, no advanced tools');
  console.log('  node calculate-cost-interactive.js 5 8      # 5 dumps, 8 advanced tool queries');
  console.log('  node calculate-cost-interactive.js 10 20    # 10 dumps, 20 advanced queries');
  
  console.log('\n💡 Quick Reference:');
  console.log('  • 1 minidump = ~$0.0075');
  console.log('  • 5 minidumps = ~$0.0377');
  console.log('  • Each advanced tool = ~$0.0435 (includes grounding)');
}

// Show cost comparison table for common scenarios
if (args.length === 0) {
  console.log('\n📊 Common Scenarios:');
  console.log('┌─────────────────────────┬──────────┬──────────────┬────────────┐');
  console.log('│ Scenario                │ Dumps    │ Adv. Tools   │ Cost       │');
  console.log('├─────────────────────────┼──────────┼──────────────┼────────────┤');
  
  const scenarios = [
    { name: 'Quick check', dumps: 1, tools: 0 },
    { name: 'Single deep dive', dumps: 1, tools: 4 },
    { name: 'Small batch', dumps: 5, tools: 0 },
    { name: 'Batch + investigate', dumps: 5, tools: 4 },
    { name: 'Large analysis', dumps: 10, tools: 8 },
  ];
  
  scenarios.forEach(s => {
    const cost = calculateCost(s.dumps, s.tools);
    console.log(`│ ${s.name.padEnd(23)} │ ${s.dumps.toString().padStart(8)} │ ${s.tools.toString().padStart(12)} │ $${cost.totalCost.toFixed(4).padStart(9)} │`);
  });
  
  console.log('└─────────────────────────┴──────────┴──────────────┴────────────┘');
}