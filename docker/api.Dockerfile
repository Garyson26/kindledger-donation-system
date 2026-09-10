# =============================================================================
# KindLedger API - Node 20, multi-stage, non-root
# =============================================================================
# Build context is ./Backend (see docker-compose.yml).
#
#   docker build -f docker/api.Dockerfile ./Backend
#
# NOTE: this image cannot usefully run until Phase 3. Backend/config/db.js
# still requires MONGODB_URI and calls process.exit(1) without it. The image
# is correct and ready; the application inside it is not yet.
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: dependencies
# -----------------------------------------------------------------------------
# Installed with the full dev dependency set so `prisma generate` can run, then
# discarded. Only production node_modules reach the final image.
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS deps

WORKDIR /app

# openssl is required by Prisma's query engine at generate time.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy manifests first so the layer cache survives source-only changes.
# package-lock.json is optional today because neither project commits one
# (SEC-12). Once it is committed, change this to `npm ci` for reproducibility.
COPY package.json package-lock.json* ./

RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Generate the Prisma client against the schema.
COPY prisma ./prisma
RUN npx prisma generate

# Drop dev dependencies, keeping the generated client in place.
RUN npm prune --omit=dev


# -----------------------------------------------------------------------------
# Stage 2: runtime
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

# openssl again - Prisma needs it at runtime, not just to generate.
# curl is here for the Phase 3 /api/health probe.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=5000 \
    UPLOADS_DIR=/var/lib/kindledger/uploads

WORKDIR /app

# The node:20 images already ship an unprivileged `node` user (uid 1000).
# Create the uploads mount point owned by it so the volume is writable without
# running as root.
RUN mkdir -p "$UPLOADS_DIR" && chown -R node:node "$UPLOADS_DIR"

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .

USER node

EXPOSE 5000

# dumb-init is deliberately not used: Node 20 handles SIGTERM correctly as PID
# 1 provided the application installs a handler, which is Phase 3's job for
# graceful shutdown of the connection pool.
CMD ["node", "app.js"]
