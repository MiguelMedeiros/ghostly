# Built from the repository root (see docker-compose.yml): the site syncs the
# WISP documents and quotes core source at build time.

# Stage 1: Dependencies
FROM node:26-alpine AS deps
WORKDIR /app/apps/website

COPY apps/website/package.json apps/website/package-lock.json ./
RUN npm ci

# Stage 2: Build
FROM node:26-alpine AS builder
WORKDIR /app/apps/website

COPY --from=deps /app/apps/website/node_modules ./node_modules
COPY apps/website/ ./
COPY docs /app/docs
COPY packages/core/src /app/packages/core/src
COPY packages/cli/SKILL.md /app/packages/cli/SKILL.md
COPY .github/CONTRIBUTING.md .github/SECURITY.md /app/.github/

ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# Stage 3: Production
FROM node:26-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/apps/website/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/apps/website/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/website/.next/static ./.next/static

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
