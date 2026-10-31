// Processing limits and constants
export const PROCESSING_LIMITS = {
    // Characters of extracted dump strings in a fallback AI prompt, enforced by
    // sanitizeExtractedContent (the only limit; issue #353). 25,000 is what has
    // always applied: it fits the local prompt's TARGET_TOKENS budget and keeps
    // the large-dump failover prompt (no token budget) small.
    MAX_STRINGS_LENGTH: 25000,
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
// Public Cloudflare Turnstile site key (not a secret): the upload widget and the BSOD AI chat share it.
export const TURNSTILE_SITE_KEY = '0x4AAAAAAABiq2_hH-dGCkQi';
