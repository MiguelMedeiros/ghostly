# Ghostly Browser

Ghostly Browser is a Chromium extension (Manifest V3) that runs a full Ghostly peer: chats, groups, calls, files, wallets, identities and shared local web apps. It is the same peer and the same UI as the [web app](WEB.md) and Desktop, so an invite made in one works in the others. Install it from the Chrome Web Store or the release zip: [INSTALLATION.md](INSTALLATION.md#browser-extension-chrome-brave-edge).

What the extension adds over the web app: the peer keeps running with no Ghostly tab open, and it can share a local web app and open a contact's.

## Run it locally

```bash
npm ci
npm run build:extension
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. **Load unpacked** and pick `apps/extension/dist`.
3. Click the Ghostly icon in the toolbar. Ghostly opens in a tab.

`npm run dev -w @ghostly/extension` rebuilds on change; press reload on `chrome://extensions` afterwards.

### Permissions

| Permission | Why |
|---|---|
| `offscreen` | The peer runs in an offscreen document |
| `storage` | Settings and state |
| `debugger` | Only on a tab Ghostly opens to show a contact's app ([Opening a contact's app](#opening-a-contacts-app)) |
| `notifications` (optional) | Asked when you turn notifications on |
| `identity` (optional) | Asked from the click, for identity proofs that sign in with a provider |
| `localhost` hosts (optional) | Asked the first time you share a local app |

## Try it

Two Chrome profiles (or two machines), each with the extension:

1. **A:** *New*, *Chat*, and copy the invite (a `ghostly1…` code or its link).
2. **B:** *Join*, paste it. The first message can arrive over the DHT within seconds; the two then connect peer to peer by themselves.
3. **A:** on the **Services** page, add a local app (a name and a target such as `localhost:3400`) and pick who may open it. Chrome asks whether Ghostly may access `localhost`.
4. **B:** in the chat, *+*, *Shared services*, and open the app. A tab opens and the app loads from A's machine.
5. The connection icon in the chat header shows how the chat is carried (for example "Connected · WebRTC").

Browser to Desktop and browser to web app work the same way. When WebRTC cannot connect between a browser and a Desktop, the chat goes over Iroh through a relay ([TRANSPORTS.md](TRANSPORTS.md#iroh)).

### Automated

```bash
npm test                 # unit tests, including packets produced by the Rust implementation
npm run test:e2e         # builds the extension, then the end-to-end suite
```

The e2e suite ([e2e/README.md](../e2e/README.md)) launches Chromium profiles with the extension loaded: pairing, chat, files, calls with the web app, sharing and opening a local app (ES modules, CSS, images, JSON `POST`, large downloads, redirects, navigation), stop sharing, go offline. `HEADED=1` shows the windows. The test grants `localhost` in a copy of the manifest, because automation cannot click Chrome's permission prompt.

## How it is built

```
┌─ app.html (tab) ──────────┐      ┌─ service worker ────────────────┐
│ the shared React UI       │      │ keeps the offscreen page alive  │
│ calls: camera, microphone │      │ opens the UI                    │
└──────────┬────────────────┘      │ viewer: DevTools Fetch domain   │
           │ port "ui"             └──────────────┬──────────────────┘
           ▼                                      │ runtime messages
┌─ offscreen.html: the peer ──────────────────────▼──────────────────┐
│ GhostlyNode (@ghostly/browser) → one GhostLink per chat            │
│   Pkarr through relays   DHT text, capability records             │
│   WebRTC                 RTCPeerConnection + "ghostly/1"           │
│   Iroh (wasm)            through an Iroh relay                     │
│   HyperDHT               through a HyperDHT relay, when set        │
│   chat session           frames, files, payments, shared apps      │
│ IndexedDB and file storage: chats, messages, wallets, settings     │
└────────────────────────────────────────────────────────────────────┘
```

- **One UI.** The extension builds `apps/ui/src/` as is. A Vite plugin shared with the web app and Desktop (`packages/browser/vite-plugin.ts`) swaps the modules that touch the platform for stand-ins in `packages/browser/src/platform`.
- **Why an offscreen document.** Manifest V3 service workers have no `RTCPeerConnection` and are stopped when idle. The offscreen document (reason `WEB_RTC`) has WebRTC and lives as long as the browser runs the extension, which is the peer's lifetime.
- **State.** Chats (with their keys), messages, shared apps, wallets and settings survive restarts. Files go to the origin-private file system. Presence exists only while the offscreen document runs. Chat keys are stored as Desktop stores them, unencrypted in the browser profile; wallet secrets are sealed with a device key.
- **Relays.** Pkarr relays, the Iroh relays and the HyperDHT relay are set in Settings, Network. See [TRANSPORTS.md](TRANSPORTS.md).

## Sharing a local app

- Nothing is exposed until you add it on the Services page: a name and a target. Targets must be `localhost`, `127.0.0.1` or `[::1]`.
- Chrome's own prompt grants the extension access to that host. Without it the extension cannot reach your machine.
- You pick which contacts may open each app. The host checks the grant on every request.
- Contacts see the name and an id, never the address. A request names a service id and a path, and your app maps the id to the target ([what the host guarantees](PROTOCOL.md#64-ghostly-http1)).
- Stopping an app makes its id stop resolving at once.

Requests reach your app from the extension, without your cookies, with `Host: localhost:<port>` and, for non-`GET` requests, `Origin: chrome-extension://<id>`.

## Opening a contact's app

A remote app needs a real origin that is not the extension's. The Manifest V3 options were weighed like this:

| Approach | Verdict |
|---|---|
| Serve the app from `chrome-extension://…` | Rejected: remote code would run with the extension's privileges, which MV3's remote code policy forbids |
| A `sandbox` page or CSP | Opaque origins are not controlled by service workers, so subresources cannot be served |
| Fetch, rewrite and inject into a sandboxed iframe | Relative ES modules, `history.pushState` and anything not rewritten break |
| `declarativeNetRequest` / `webRequest` | Cannot supply response bodies in MV3 |
| A service worker on a real web origin | Needs a Ghostly-operated website in the path |
| **`chrome.debugger` Fetch domain on a virtual origin** | **Chosen** |

Ghostly opens a tab, attaches the debugger to **that tab only**, and answers requests to `https://<service>.<peer key>.invalid/` with what the contact's app sent over the chat session:

- a normal, secure-context origin, isolated from the extension and from every other contact and app;
- each contact is a site of its own (`.invalid` is a top-level domain to the browser);
- the tab serves only the app it was opened for;
- `.invalid` never resolves, so a request that is not intercepted goes nowhere;
- requests to other origins (CDNs, APIs) are not touched;
- the debugger detaches when the tab leaves the virtual origin or closes.

The cost is Chrome's "Ghostly started debugging this browser" banner while such a tab is open.

### How the `debugger` permission is kept narrow

Chrome grants `debugger` for every tab and does not allow it as an optional permission, so the manifest declares it. The extension keeps its own use of it to the viewer:

- Only the service worker (`apps/extension/src/background.ts`) calls `chrome.debugger`; a test fails if any other source file does.
- A page asks for a contact's service (peer key and service id), never for a tab. The worker opens the tab itself, and attaches only to that tab.
- Every command goes to a tab the worker opened for a service. A tab stops being one when it closes, leaves the virtual origin, or the person cancels Chrome's debugging bar. If an event comes from any other tab, the worker sends it no command and detaches from it.
- Only `Fetch.enable`, `Page.enable`, `Fetch.fulfillRequest` and `Fetch.failRequest` are ever sent. Anything else is refused.
- The worker and the offscreen document (the peer) only hear the extension's own pages: every message and every port is checked for the extension's id and origin (`apps/extension/src/shared/sender.ts`), and anything else is dropped or disconnected.

Chrome gives an API to every page of an extension, not to one part of it, so an extension page that ran foreign script could still call `chrome.debugger` itself. The CSP (`script-src 'self'`, no inline script) is what keeps foreign script out of those pages. The offscreen document only gets `chrome.runtime`.

### What works, what does not

Works: HTML, CSS, scripts (inline, classic, ES modules, dynamic `import()`), images, fonts, `fetch`/XHR with any method and binary bodies, redirects, in-app navigation and history, `localStorage`/IndexedDB per contact and app, responses up to 32 MiB.

Does not work yet:

- **WebSockets**, including dev-server hot reload. The Fetch domain does not see them.
- **Streaming responses** (server-sent events, progressive downloads): a response is handed to the page once complete.
- **HTTP cookies with a browser host.** `fetch` can neither send `Cookie` nor read `Set-Cookie`. Token headers (`Authorization`) work.
- **Service workers** of the remote app.
- Apps that hard-code `http://localhost:…` URLs (they resolve on the visitor's machine). Relative URLs are fine.
- Apps that reject the `chrome-extension://` `Origin` on non-`GET` requests (strict CSRF checks).

## Security notes

- **Reachability.** Only contacts, authenticated by the chat session's pinned keys.
- **The proxy boundary.** Loopback-only targets, service ids instead of URLs, path confinement, no redirects off the target, no host credentials, header hygiene, limits on body size, concurrency and time ([protocol](PROTOCOL.md#64-ghostly-http1), tests in `packages/core/test/http.test.ts`).
- **Remote code** runs in its own web origin, never in the extension's.
- **Camera and microphone** are asked for when you place or answer a call, never in the background.
- **Relays, STUN, TURN** see ciphertext and metadata only.
- An app you share is as exposed to the contacts you picked as it is to you on `localhost`.

## Updates

- **From the Chrome Web Store:** Chrome downloads a new version and holds it while Ghostly runs. Ghostly then offers a button that calls `chrome.runtime.reload()`, which ends the offscreen document and every connection, so it never happens on its own. Left alone, Chrome applies it once nothing is running.
- **Unpacked:** Chrome never updates it. Ghostly asks `ghostly.tools/latest.json` for the newest release and points at the download.

The check only runs while **Settings, Updates** allows it.

## Desktop

Ghostly Desktop runs the same peer in its WebView as a third host (`apps/ui/src/desktop/host.ts`), with Rust doing what a WebView cannot:

| | Browser | Desktop |
|---|---|---|
| Pkarr | `RelayTransport` (HTTP relays) | The Mainline DHT directly, plus writes to the relays (`apps/desktop/src/pkarr_network.rs`) |
| Iroh, HyperDHT | Through relays | Native Iroh and a HyperDHT sidecar |
| Local fetch | `fetch` with a host permission | `local_fetch` in Rust: loopback addresses the person allowed in a native dialog only (`local_access.rs`), never follows redirects, forwards cookies, no `Origin` header |
| Viewer | `chrome.debugger` on a virtual origin | A window per app on a `ghostly-svc://<service>.<peer>` origin, with no access to Tauri commands |

Profiles (`GHOSTLY_PROFILE`) get their own storage and peer, so two instances can run side by side.
