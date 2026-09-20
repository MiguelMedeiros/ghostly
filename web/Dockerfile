# check=skip=SecretsUsedInArgOrEnv
# VITE_GIPHY_API_KEY is not a secret here, whatever the linter's list of names
# says: Vite inlines it into the bundle every browser downloads, which is what a
# Giphy browser key is for. Nothing that must stay out of the image is passed this way.
# Build context is the repository root: the web app is one workspace among several.
#   docker compose up --build
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/react/package.json packages/react/
COPY packages/browser/package.json packages/browser/
COPY extension/package.json extension/
COPY web/package.json web/
RUN npm ci --ignore-scripts

COPY tsconfig.json vite-env.d.ts ./
COPY src src
COPY packages packages
COPY web web

# Optional: GIFs from Giphy need a key (the Retro source works without).
ARG VITE_GIPHY_API_KEY=""
ENV VITE_GIPHY_API_KEY=$VITE_GIPHY_API_KEY
# Which commit this image serves: `/version.json` carries it, and a running
# tab compares it to know a deploy happened. There is no git in this stage.
ARG GHOSTLY_BUILD=""
ENV GHOSTLY_BUILD=$GHOSTLY_BUILD
RUN npm run build -w @ghostly/web

FROM nginx:1.30-alpine
COPY web/nginx-headers.conf /etc/nginx/ghostly-headers.conf
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
