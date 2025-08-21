// Test script for symbol resolution
import { SymbolResolver } from './utils/symbolResolver.js';

console.log('Testing Symbol Resolution...\n');

// Create a symbol resolver
const resolver = new SymbolResolver();

// Register some test modules (simulating common Windows modules)
const testModules = [
    { name: 'ntoskrnl.exe', baseAddress: 0xFFFFF80000000000, size: 0x800000 },
    { name: 'hal.dll', baseAddress: 0xFFFFF80000800000, size: 0x100000 },
    { name: 'ndis.sys', baseAddress: 0xFFFFF80000900000, size: 0x200000 },
    { name: 'tcpip.sys', baseAddress: 0xFFFFF80000B00000, size: 0x300000 },
    { name: 'nvlddmkm.sys', baseAddress: 0xFFFFF80001000000, size: 0x1000000 }
];

console.log('Registering modules:');
testModules.forEach(module => {
    console.log(`  ${module.name}: 0x${module.baseAddress.toString(16)} (${(module.size / 1024 / 1024).toFixed(2)} MB)`);
    resolver.registerModule(module.baseAddress, module.size, module.name);
});

// Test addresses to resolve
const testAddresses = [
    0xFFFFF80000001000, // Should resolve to ntoskrnl!KeBugCheckEx+0x0
    0xFFFFF80000005234, // Should resolve to ntoskrnl!ExAllocatePoolWithTag+0x234
    0xFFFFF80000801000, // Should resolve to hal!HalProcessorIdle+0x0
    0xFFFFF80000950000, // Should resolve to ndis+0x50000
    0xFFFFF80001234567, // Should resolve to nvlddmkm+0x234567
    0xDEADBEEF00000000, // Should resolve to unknown
];

console.log('\nResolving addresses:');
testAddresses.forEach(addr => {
    const resolved = resolver.resolve(addr);
    console.log(`  0x${addr.toString(16).padStart(16, '0')} => ${resolved.formatted}`);
});

// Test batch resolution
console.log('\nBatch resolution test:');
const batchResolved = resolver.resolveBatch(testAddresses);
batchResolved.forEach((symbol, idx) => {
    console.log(`  [${idx}] ${resolver.formatSymbol(symbol, true)}`);
});

// Show symbol summary
console.log('\n' + resolver.getSymbolSummary());

console.log('\nSymbol resolution test complete!');