# Ghostly on the web

The Ghostly peer and the shared UI in a browser tab, nothing to install: [app.ghostly.tools](https://app.ghostly.tools).
`src/host.ts` is the web host; the UI is the shared one (`apps/ui/src/`). What it can and cannot do
compared to the extension and Desktop: [docs/WEB.md](../../docs/WEB.md).

```bash
npm run build:web                          # from the root: apps/web/dist
npm run dev -w @ghostly/web                # Vite dev server
docker compose -f infra/docker-compose.yml up --build -d   # from the root: the image (apps/web/Dockerfile, nginx), on 127.0.0.1:8080
```

`GHOSTLY_WEB_BIND` moves the port; `GHOSTLY_BUILD` names the commit `/version.json` reports, which is how
open tabs learn about a deploy ([docs/RELEASING.md](../../docs/RELEASING.md#5-deploy)). End-to-end tests:
`e2e/web/` ([e2e/README.md](../../e2e/README.md)).
