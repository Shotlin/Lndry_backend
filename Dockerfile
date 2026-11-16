# ─── Stage 1: Install dependencies ─────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ─── Stage 2: Production image ────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Security: run as non-root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy dependencies and source
COPY --chown=appuser:appgroup --from=deps /app/node_modules ./node_modules
COPY --chown=appuser:appgroup . .

# Remove dev files
RUN rm -rf .env .env.example tests/ .github/ .vscode/ *.md \
    && mkdir -p logs \
    && chown appuser:appgroup /app logs

USER appuser

# Expose port (matches Fastify listen port)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health/ready || exit 1

# Start — pm2-runtime (not `pm2 start`) runs in the foreground as PID 1 and
# forwards signals correctly in containers; plain `pm2` daemonizes, which is
# the wrong tool here. ecosystem.config.cjs runs the API in cluster mode
# across all available CPU cores. Invoked via the local node_modules/.bin
# path (not npx) so no registry lookup is attempted at container start.
CMD ["node_modules/.bin/pm2-runtime", "start", "ecosystem.config.cjs", "--env", "production"]
