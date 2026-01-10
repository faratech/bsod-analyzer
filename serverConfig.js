export const SECURITY_CONFIG = {
  api: {
    maxRequestSize: 10 * 1024 * 1024, // 10MB max request for general API endpoints
    maxUploadRequestSize: 150 * 1024 * 1024, // 150MB for file upload endpoints (base64-encoded 100MB files)
    rateLimiting: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      maxRequests: 500, // Limit each IP to 500 requests per windowMs
      message: 'Too many requests from this IP, please try again later'
    }
  }
};