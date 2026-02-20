# Build stage
FROM node:18-alpine AS builder

WORKDIR /app

# Install dependencies for build
COPY package.json package-lock.json ./
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
RUN npx tsc

# Production stage
FROM node:18-alpine

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --only=production

# Copy built artifacts from builder
COPY --from=builder /app/build ./build
# Copy default config (optional, can be overridden by volume)
COPY config.json ./config.json

# Expose API port
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production

# Start command
CMD ["node", "build/index.js"]
