# Ghostly's HyperDHT relay: browsers reach the HyperDHT through it (see README.md).
# Debian, not Alpine: HyperDHT's UDP (udx-native) and sodium-native ship glibc prebuilds.
FROM node:22-bookworm-slim
WORKDIR /relay
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY relay.mjs server.mjs ./
USER node
ENV PORT=49443 NODE_ENV=production
EXPOSE 49443
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.mjs"]
