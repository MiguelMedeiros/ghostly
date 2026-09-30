# Ghostly Browser (extension)

The Ghostly peer as a Chromium extension (Manifest V3). The service worker (`src/background.ts`) opens an
offscreen document (`src/offscreen.ts`) that runs the peer: it has WebRTC and lives as long as the browser
runs the extension. The UI is the shared one (`src/` at the root), in `app.html`.

What it is for people, and how to install it: [docs/BROWSER.md](../../docs/BROWSER.md).

```bash
npm run build:extension                    # from the root: apps/extension/dist, load it unpacked in chrome://extensions
npm run dev -w @ghostly/extension          # rebuild on change (development mode)
npm test -w @ghostly/extension             # unit tests, against a fake chrome.* (test/)
npm run test:attacks -w @ghostly/extension # a malicious contact against a real build (two Chromium profiles, network)
```

End-to-end tests of the extension: `e2e/extension/` ([e2e/README.md](../../e2e/README.md)).
