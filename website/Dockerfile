# Built from the repository root (see docker-compose.yml): the site syncs the
# WISP documents and quotes core source at build time.

# Stage 1: Dependencies
FROM node:25-alpine AS deps
WORKDIR /app/website

COPY website/package.json website/package-lock.json ./
RUN npm ci

# Stage 2: Build
FROM node:25-alpine AS builder
WORKDIR /app/website

COPY --from=deps /app/website/node_modules ./node_modules
COPY website/ ./
COPY docs /app/docs
COPY packages/core/src /app/packages/core/src
COPY CONTRIBUTING.md SECURITY.md /app/

ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# Stage 3: Production
FROM node:25-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/website/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/website/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/website/.next/static ./.next/static

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
