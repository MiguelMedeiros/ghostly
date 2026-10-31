# Build context is the repository root: the web app is one workspace among several.
#   docker compose -f infra/docker-compose.yml up --build
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
# --ignore-scripts skips the root postinstall, and with it the dependency patches every other build has (the browser
# fixes in keet-identity-key and bip39-mnemonic among them): apply them here, and fail the build when one does not.
COPY tools/patches tools/patches
RUN npm ci --ignore-scripts && npx patch-package --patch-dir tools/patches --error-on-fail

COPY tsconfig.json ./
COPY apps/ui apps/ui
COPY packages packages
COPY apps/web apps/web

# Which commit this image serves: `/version.json` carries it, and a running
# tab compares it to know a deploy happened. There is no git in this stage.
ARG GHOSTLY_BUILD=""
ENV GHOSTLY_BUILD=$GHOSTLY_BUILD
# Where a contact's shared web app runs (apps/web/src/svc/): `https://*.<domain>`, a wildcard pointed at this same
# image, and the app's own origin. Left empty, the web app opens no contact's app and the button says so.
ARG VITE_SERVICES_HOST=""
ARG VITE_SERVICES_APP_ORIGIN=""
ENV VITE_SERVICES_HOST=$VITE_SERVICES_HOST VITE_SERVICES_APP_ORIGIN=$VITE_SERVICES_APP_ORIGIN
# The e2e suite's mini-app hook never goes into an image (apps/web/appsTestFlag.ts).
ENV VITE_APPS_TEST=
# Nor translation's switch while it is being built (apps/web/translateFlag.ts), with or without GHOSTLY_BUILD.
ENV VITE_TRANSLATE=
RUN npm run build -w @ghostly/web

FROM nginx:1.30-alpine
COPY apps/web/nginx-headers.conf /etc/nginx/ghostly-headers.conf
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/web/nginx-services.conf /etc/nginx/conf.d/services.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
# With a services host, the app's page may frame it (`frame-src`), and only the app's page may frame the bridge there
# (`frame-ancestors`): a contact's app opens on an origin of its own (apps/web/src/svc/).
ARG VITE_SERVICES_HOST=""
ARG VITE_SERVICES_APP_ORIGIN=""
RUN if [ -n "$VITE_SERVICES_HOST" ]; then \
      sed -i "s|frame-src 'self';|frame-src 'self' ${VITE_SERVICES_HOST};|" /etc/nginx/ghostly-headers.conf \
      && grep -qF "frame-src 'self' ${VITE_SERVICES_HOST};" /etc/nginx/ghostly-headers.conf \
      && sed -i "s|form-action 'none'\" always;|form-action 'none'; frame-ancestors ${VITE_SERVICES_APP_ORIGIN}\" always;|" /etc/nginx/conf.d/services.conf \
      && grep -qF "frame-ancestors ${VITE_SERVICES_APP_ORIGIN}\"" /etc/nginx/conf.d/services.conf; \
    fi
EXPOSE 80
