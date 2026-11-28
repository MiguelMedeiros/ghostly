# Self-hostable Pkarr relay proxy with Batch GET/PUT and WebSocket/SSE push subscriptions (see README.md).
FROM node:22-bookworm-slim
WORKDIR /relay
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY relay.mjs server.mjs ./
USER node
ENV PORT=49490 HOST=0.0.0.0 NODE_ENV=production
EXPOSE 49490
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.mjs"]
