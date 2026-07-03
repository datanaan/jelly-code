FROM node:20-slim AS builder

WORKDIR /app

# Install dependencies first (for Docker layer caching)
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# Production image
FROM node:20-slim

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

EXPOSE 8095

CMD ["node", "dist/server/index.js"]
