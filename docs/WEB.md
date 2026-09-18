# Ghostly on the web

The same peer and the same UI as [Ghostly Browser](BROWSER.md), running in a tab. Nothing to install: open the page and you are a Ghostly peer until you close it.

## Run it

```bash
docker compose up --build -d
```

Then open <http://localhost:8080>. `docker compose down` stops it. For GIFs from Giphy, put `VITE_GIPHY_API_KEY` in `.env` before building (the Retro source needs no key).

Without Docker:

```bash
npm install && npm run dev -w @ghostly/web
```

serves it on <http://localhost:5180> with hot reload, and `npm run build:web` writes the static site to `web/dist`.

What is served is static files (nginx, `web/nginx.conf`). There is no Ghostly backend: the peer runs in the visitor's tab, reaches Pkarr through relays, talks to contacts over WebRTC, and keeps its state in that browser's IndexedDB and localStorage. It needs a secure context, which `http://localhost` is; anywhere else, serve it over HTTPS.

`node web/test/e2e.mjs` checks a web page against the extension: chat, WebRTC link, a file, sats on the test mint, a video call.

## How it shares code

```
src/                 the UI (Desktop's, unchanged)
packages/core        the protocol
packages/react       hooks shared by every client
packages/browser     the browser peer: engine, wallet, IndexedDB, and the stand-ins
                     for the five Desktop modules that touch the platform
extension/           host: peer in an offscreen document, Chrome permissions, viewer tabs
web/                 host: peer in the page, one tab at a time
```

A host (`packages/browser/src/host.ts`) is the small part that differs: how a page reaches the peer, whether the user can grant access to local addresses, how a contact's web app is opened. Both clients build `src/` with the same Vite plugin (`packages/browser/vite-plugin.ts`).

## What a web page cannot do

| | Web | Extension | Desktop |
|---|---|---|---|
| Chat, calls, files, sats | ✅ | ✅ | chat and calls today |
| Runs while no window is open | no, the peer is the tab | yes, until the browser closes | yes, until the app closes |
| Share a local web app | ❌ | ✅ | planned |
| Open a contact's web app | ❌ for now | ✅ | planned |

- **Sharing a local app** means fetching `http://localhost:…` from the page. Browsers only allow that when the local app opts in with CORS (and Private Network Access) headers, and there is no permission a page can ask for. The UI says so instead of offering a button that would fail.
- **Opening a contact's app** needs an origin for it that is not Ghostly's own, or the app could read your keys and ecash. The extension makes one up per service; on the web that takes a wildcard subdomain with a service worker on each, bridged to the peer in the app's tab. It is static hosting, no backend, and not built yet. The button explains itself meanwhile.
- **One tab.** Two tabs would publish under the same keys and spend from the same wallet at once, so the peer takes a Web Lock and a second tab waits for the first to close.
- **Trust.** An extension is a package you installed once. A web page is code a server hands you on every visit; whoever controls that server controls your keys and your wallet. Host it yourself, or use one you trust.
