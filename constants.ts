// Processing limits and constants
export const PROCESSING_LIMITS = {
    MAX_STRINGS_LENGTH: 262144, // 256KB of extracted strings (increased from 25KB for better analysis)
    HEX_DUMP_LENGTH: 32768, // 32KB hex dump (increased from 1KB for more context)
    MAX_FILE_SIZE: 100 * 1024 * 1024, // 100MB
    PROCESSING_TIMEOUT: 30000, // 30 seconds
    MAX_BINARY_SCAN_SIZE: 524288, // 512KB for binary pattern scanning
    MAX_STACK_MEMORY_SIZE: 131072, // 128KB of stack memory to analyze
    MAX_MODULE_INFO: 100, // Maximum number of modules to include detailed info
};

export const FILE_SIZE_THRESHOLDS = {
    MINIDUMP: 5 * 1024 * 1024, // 5MB threshold for minidump vs kernel dump
};