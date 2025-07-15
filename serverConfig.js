export const SECURITY_CONFIG = {
  api: {
    maxRequestSize: 10 * 1024 * 1024, // 10MB max request to backend
    rateLimiting: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      maxRequests: 100, // Limit each IP to 100 requests per windowMs
      message: 'Too many requests from this IP, please try again later'
    }
  }
};