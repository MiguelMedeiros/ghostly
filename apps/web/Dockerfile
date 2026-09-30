# Build context is the repository root: the web app is one workspace among several.
#   docker compose up --build
FROM node:26-alpine AS build
WORKDIR /app

COPY package.json package-lock.json .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/react/package.json packages/react/
COPY packages/browser/package.json packages/browser/
# The web app loads Iroh from this workspace (packages/browser/src/platform/irohWeb.ts); without its package.json
# npm ci links nothing and the type check fails on "@ghostly/iroh-web".
COPY packages/iroh-web/package.json packages/iroh-web/
COPY apps/extension/package.json apps/extension/
COPY apps/web/package.json apps/web/
RUN npm ci --ignore-scripts

COPY tsconfig.json vite-env.d.ts ./
COPY src src
COPY packages packages
COPY apps/web apps/web

# Which commit this image serves: `/version.json` carries it, and a running
# tab compares it to know a deploy happened. There is no git in this stage.
ARG GHOSTLY_BUILD=""
ENV GHOSTLY_BUILD=$GHOSTLY_BUILD
RUN npm run build -w @ghostly/web

FROM nginx:1.30-alpine
COPY apps/web/nginx-headers.conf /etc/nginx/ghostly-headers.conf
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
