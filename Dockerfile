# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
# Using legacy-peer-deps to handle React 19 compatibility
RUN npm install --legacy-peer-deps && \
    npm cache clean --force

# Copy source files
COPY . .

# Build the application
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy package files
COPY package*.json ./

# Install only production dependencies
# Using legacy-peer-deps to handle React 19 compatibility
RUN npm install --omit=dev --legacy-peer-deps && \
    npm cache clean --force

# Copy built assets from builder stage
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist

# Copy server file and other necessary files
COPY --chown=nodejs:nodejs server.js ./
COPY --chown=nodejs:nodejs services ./services
COPY --chown=nodejs:nodejs components ./components
COPY --chown=nodejs:nodejs pages ./pages
COPY --chown=nodejs:nodejs public ./public
COPY --chown=nodejs:nodejs *.tsx ./
COPY --chown=nodejs:nodejs *.ts ./
COPY --chown=nodejs:nodejs *.css ./
COPY --chown=nodejs:nodejs index.html ./

# Switch to non-root user
USER nodejs

# Expose port 8080 (Cloud Run requirement)
EXPOSE 8080

# Set production environment
ENV NODE_ENV=production

# Start the server with dumb-init
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]