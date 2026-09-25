# A local AT Protocol network for the e2e suite (server.mjs): a PLC directory in memory and a reference PDS.
# Debian, not Alpine: the PDS's SQLite (better-sqlite3) and sharp ship glibc prebuilds.
FROM node:22-bookworm-slim
WORKDIR /atproto
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.mjs ./
USER node
ENV ATPROTO_PLC_PORT=2582 ATPROTO_PDS_PORT=2583 ATPROTO_ACCOUNTS= NODE_ENV=production
EXPOSE 2582 2583
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s CMD node -e "fetch('http://127.0.0.1:'+process.env.ATPROTO_PDS_PORT+'/xrpc/_health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.mjs"]
