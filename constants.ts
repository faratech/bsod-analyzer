// Processing limits and constants
export const PROCESSING_LIMITS = {
    MAX_STRINGS_LENGTH: 65536, // 64KB of extracted strings — signal-bearing content lives in first ~32-64KB
    HEX_DUMP_LENGTH: 4096, // 4KB hex dump — larger dumps overwhelm the prompt with noise
    MAX_FILE_SIZE: 100 * 1024 * 1024, // 100MB
    PROCESSING_TIMEOUT: 30000, // 30 seconds
    MAX_BINARY_SCAN_SIZE: 524288, // 512KB for binary pattern scanning
    MAX_STACK_MEMORY_SIZE: 16384, // 16KB of stack memory — frames of interest are near the top
    MAX_MODULE_INFO: 100, // Maximum number of modules to include detailed info
};

export const FILE_SIZE_THRESHOLDS = {
    MINIDUMP: 5 * 1024 * 1024, // 5MB threshold for minidump vs kernel dump
};