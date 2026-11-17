# The WISP 602 group-token mock for the e2e suite (server.mjs): node:crypto only. livekit-client is here for the
# smoke page (/smoke) alone, which serves its browser bundle; nothing of it runs in Node.
FROM node:22-bookworm-slim
WORKDIR /sfu-token
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --no-package-lock && npm cache clean --force
COPY server.mjs ./
USER node
ENV SFU_TOKEN_PORT=7890
EXPOSE 7890
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+process.env.SFU_TOKEN_PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.mjs"]
