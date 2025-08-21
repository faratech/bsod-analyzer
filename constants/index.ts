// File size thresholds
export const FILE_SIZE_THRESHOLDS = {
  MINIDUMP_MAX_SIZE: 5 * 1024 * 1024, // 5MB threshold for minidump vs kernel dump
  MAX_FILE_SIZE: 50 * 1024 * 1024, // 50MB max file size
} as const;

// Processing limits
export const PROCESSING_LIMITS = {
  MAX_STRINGS_LENGTH: 25000, // Maximum characters for extracted strings
  HEX_DUMP_LENGTH: 1024, // Length of hex dump to generate
  MAX_PROCESSING_TIME: 30000, // 30 seconds timeout
  CHUNK_SIZE: 8192, // Chunk size for file reading
} as const;

// UI constants
export const UI_CONSTANTS = {
  DRAG_DROP_DELAY: 100, // Delay for drag and drop animations
  ERROR_DISPLAY_DURATION: 5000, // How long to show error messages
  ANIMATION_DURATION: 300, // Default animation duration
} as const;

// API constants
export const API_CONSTANTS = {
  SESSION_EXPIRY: 60 * 60 * 1000, // 1 hour session expiry
  RATE_LIMIT_WINDOW: 15 * 60 * 1000, // 15 minutes rate limit window
  MAX_REQUESTS: 100, // Max requests per rate limit window
} as const;

// Dump analysis constants
export const DUMP_ANALYSIS = {
  STACK_FRAME_LIMIT: 20, // Maximum stack frames to display
  HEX_BYTES_PER_LINE: 16, // Bytes per line in hex dump
  CONTEXT_LINES: 5, // Lines of context around errors
} as const;