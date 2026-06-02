FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.node.json ./
COPY src ./src
RUN npm run build:node

# ---- runtime ----
FROM node:22-alpine
WORKDIR /app

COPY package*.json ./
# Install only production deps (skips wrangler and other devdeps)
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh

EXPOSE 3000
VOLUME ["/data"]

ENTRYPOINT ["./docker-entrypoint.sh"]
