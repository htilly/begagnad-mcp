# Build from GitHub (default) or local files:
#   docker build .                          # GitHub
#   docker build --build-arg SOURCE=local . # local files
ARG SOURCE=github

# ---- builder (GitHub) ----
FROM node:22-alpine AS builder-github
WORKDIR /app
RUN apk add --no-cache git
ARG CACHEBUST=1
RUN git clone https://github.com/htilly/begagnad-mcp.git .
RUN npm ci
RUN npm run build:node

# ---- builder (local) ----
FROM node:22-alpine AS builder-local
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.node.json ./
COPY src ./src
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN npm run build:node

# ---- select builder ----
FROM builder-${SOURCE} AS builder

# ---- runtime ----
FROM node:22-alpine
WORKDIR /app

COPY --from=builder /app/package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh

EXPOSE 3000
VOLUME ["/data"]

ENTRYPOINT ["./docker-entrypoint.sh"]
