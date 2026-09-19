# Ghostly Browser

Ghostly Browser is a Chromium extension that runs a full Ghostly peer: links, chat, voice and video calls, and ephemeral HTTP services. It speaks the same [protocol](PROTOCOL.md) as Ghostly Desktop through the shared [`@ghostly/core`](../packages/core) package, and an invite created in one works in the other.

## Run it locally

```bash
npm install
```

```bash
npm run build:extension
```

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** and pick `extension/dist`.
3. Click the Ghostly icon in the toolbar. Ghostly opens in a tab.

During development, `npm run dev -w @ghostly/extension` rebuilds on change; press the reload button on `chrome://extensions` afterwards.

The extension asks for three permissions up front: `offscreen` (the peer runs there), `storage`, and `debugger` (used only on the tabs Ghostly opens to show a peer's service, see [Opening a service](#opening-a-service)). Access to `localhost` is optional and requested the first time you share a service.

## Try it

### Browser ↔ Browser

Use two Chrome profiles (or two machines), each with the extension loaded.

1. **A:** *New* → *Create New Chat*, copy the invite code.
2. **B:** *New*, paste the code. Send a message; it arrives at A through the DHT within a few seconds, and the two connect peer to peer on their own shortly after.
3. **A:** *Share a local service* (bottom of the sidebar) → name `Atlas`, target `localhost:3400`. Chrome asks whether Ghostly may access `localhost`.
4. **B:** an **Atlas** button appears under the chat header. Click it. A tab opens on `https://atlas.<A's key>.invalid/`, the peers connect over WebRTC, and the app loads from A's machine.
5. Both show *Peer to peer* under the chat header; messages, call signaling and the app now travel over WebRTC.
6. **A:** *Stop*, switch to *Offline*, or close Chrome. Reload the tab on B: the service is not reachable.

### Browser ↔ Desktop

1. Create a chat in Ghostly Desktop and copy its invite code (or create the invite in the browser and use *Join* on Desktop).
2. Paste it in the browser. `_msgs`, `_ack`, `_nick` and `_call` are unchanged, so released Desktop builds interoperate. Text is verified against the Rust implementation by `npm run test:interop`. Calls run the same hook and signaling on both sides, but have so far only been exercised Browser ↔ Browser.
3. Services need a peer that understands `_svc` and `_rtc`. Desktop ignores them today and shows up in the browser as a peer without advertised services. See [Desktop](#desktop).

Desktop reaches the DHT directly, the browser goes through relays; both are views of the same DHT. `pkarr.pubky.org` is in the default relay set of both, which makes the common case fast.

### Automated

```bash
npm test
```

runs the protocol tests, including a packet produced by the Rust implementation.

```bash
cargo build -p ghostly-cli && GHOSTLY_CLI=target/debug/ghostly-cli npm run test:interop
```

exchanges messages between the Rust CLI and the TypeScript core over the real network, in both directions.

```bash
npm run test:e2e
```

runs the end-to-end suite ([e2e/README.md](../e2e/README.md)). For the extension, it launches Chromium profiles with it loaded and walks through the whole milestone: link, chat through a relay, advertise, discover, open, proxy (ES modules, CSS, images, JSON `POST`, a 3 MiB download, redirects, navigation), stop sharing, go offline, close, gone; and chat, a file and a video call with the web app. `HEADED=1` shows the windows. The test grants the `localhost` permission in a copy of the manifest, because Chrome's permission prompt cannot be clicked by automation.

## How it is built

```
┌─ app.html (tab) ──────────┐      ┌─ service worker ────────────────┐
│ Desktop's React UI (src/) │      │ keeps the offscreen page alive  │
│ calls: camera, microphone │      │ opens the UI                    │
└──────────┬────────────────┘      │ viewer: DevTools Fetch domain   │
           │ port "ui"             └──────────────┬──────────────────┘
           ▼                                      │ runtime messages
┌─ offscreen.html: the peer ──────────────────────▼──────────────────┐
│ GhostlyNode → one GhostLink per peer (@ghostly/core)               │
│   LinkSession   Pkarr records through relays                       │
│   DataLink      RTCPeerConnection + "ghostly/1" DataChannel        │
│   HttpHost      service id → fetch(localhost)                      │
│   HttpClient    requests to the peer's services                    │
│ IndexedDB: links, messages, services, settings                     │
└────────────────────────────────────────────────────────────────────┘
```

**One UI.** The extension does not have a UI of its own: it builds Desktop's `src/` as is, so chats, themes, languages, the lock screen, emoji and GIF pickers, QR invites and the call overlay are the same code and look the same. A Vite plugin shared with the [web app](WEB.md) (`packages/browser/vite-plugin.ts`) swaps the five Desktop modules that touch the platform for stand-ins in `packages/browser/src/platform` with identical exports:

| Desktop module | In the browser |
|---|---|
| `lib/pkarr.ts`, `lib/crypto.ts` (Rust through Tauri) | `@ghostly/core` in TypeScript |
| `hooks/useChat.ts`, `hooks/useBackgroundPoller.ts` (the Pkarr loop, in the page) | thin hooks over the peer, which runs that loop (`LinkSession`) in the background for every chat |
| `lib/platform.ts` (services: not available yet) | services, presence and network settings backed by the peer |

Sessions stay in `localStorage` exactly as on Desktop; `platform/sync.ts` keeps them in step with the links the peer runs. GIFs need `VITE_GIPHY_API_KEY` in the repository's `.env`, as on Desktop (Giphy retired the public fallback key).

**Why an offscreen document.** Manifest V3 service workers have no `RTCPeerConnection` and are terminated when idle. The offscreen document (reason `WEB_RTC`) has WebRTC and lives as long as the browser runs the extension, which is exactly the lifetime of the peer.

**State.** Links (including their seeds), messages, shared services and settings are in IndexedDB and survive restarts. Presence does not: it exists while the offscreen document runs. Seeds are stored the way Desktop stores them, unencrypted in the profile.

**Identity.** Unchanged from Desktop: one identity per link, created with the link. There is no Pubky Ring integration and no long-lived key.

**Relays.** Configurable in *Settings*. Every relay is published to, they are read in turn, and the newest packet with a valid signature wins, so no single relay is a dependency. Public relays allow about 120 requests a minute per IP address; Ghostly polls accordingly and connects peers over WebRTC as soon as both are online, after which Pkarr is only touched once a minute.

## Sending files

The paperclip next to the GIF button sends a file of up to 100 MiB straight to your contact over WebRTC; both of you have to be online. Images (PNG, JPEG, GIF, WebP) are previewed in the chat, everything else shows as a file with a save button, and nothing is ever opened automatically. File contents are kept in IndexedDB until the chat is deleted. Pages and the peer share that database, so the bytes never pass through extension messaging.

## Sats

Ghostly Browser has an ecash ([Cashu](https://cashu.space)) wallet, in the sidebar.

- **Receive over Lightning:** *Receive* asks the mint for an invoice; pay it from any Lightning wallet and the sats arrive as ecash. **Send over Lightning:** paste an invoice under *Send*; the mint pays it from your balance, after showing the fee.
- **In a chat**, the ⚡ button sends sats to the contact or requests them. Ecash travels straight over the WebRTC link. A request also carries a Lightning invoice, so a contact on another mint (or with another wallet entirely) can still pay it; Ghostly does that on its own when you press *Pay* and share no mint.
- **Mints.** A new wallet starts with a short list of public mints (`packages/browser/src/shared/mints.ts`); the first one that answers issues your invoices. The gear icon lists them, lets you add your own, pick the primary, or add a public *test mint* with worthless sats to try things out. Test sats are shown apart and never added to real ones.
- **History and fees.** The clock icon lists every movement with what it cost, to the sat, and the total paid in fees. Fees are measured, not estimated: the difference in balance around each operation. Under the gear, each mint shows what it charges: the fee for spending ecash (`input_fee_ppk`, often zero), its Lightning limits, and its message of the day. Lightning routing fees depend on the invoice and are quoted before you pay.
- **Custody.** Ecash is custodial: the mints hold the sats and can lose them or vanish. This is pocket money. There is no seed yet, so there is nothing to restore from; *Copy backup tokens* under the gear is the only backup, and whoever has those tokens has the sats.
- **If a contact never picks up a payment** (they went offline mid-way, or do not use your mint), the ecash is still yours: refused payments come back by themselves, unconfirmed ones have a *Take it back* button.
- Both peers have to be online for a payment or a request to go through.

The automated test uses the public test mint only.

## Sharing a service

- Nothing is exposed until you add it: a name and a target. Targets must be `localhost`, `127.0.0.1` or `[::1]`.
- Chrome's own prompt grants the extension access to that host. Without it the extension cannot reach your machine at all.
- Peers see the name and an id. They never see the address, and they cannot ask for one: a request names a service id and a path, and the peer maps the id to the target you configured. See [what the host guarantees](PROTOCOL.md#64-ghostly-http1).
- A shared service is marked *Shared with your peers* and counts the requests it served. *Stop* makes its id stop resolving immediately.
- Every peer you are linked with can use every service you share. There is no per-peer selection yet.

Requests reach your application from the extension, without your cookies, with `Host: localhost:<port>` and, for non-`GET` requests, `Origin: chrome-extension://<id>`.

## Opening a service

A remote application needs a real origin. Relative URLs, ES modules, `fetch`, history and storage all hang off it, and that origin must not be the extension's. The options Manifest V3 offers were weighed like this:

| Approach | Verdict |
|---|---|
| Serve the app from `chrome-extension://…` with the extension's service worker | Rejected. Remote code would run in the extension origin, with its privileges and its CSP (no inline scripts). It is also what MV3's remote code policy forbids. |
| Same, inside a `sandbox` page or with a `sandbox` CSP | Opaque origins are not controlled by service workers, so subresources cannot be served. |
| Fetch, rewrite and inject into a sandboxed iframe | Relative ES module imports, `history.pushState` and anything not rewritten break. Too fragile for real apps. |
| `declarativeNetRequest` / `webRequest` | Cannot supply response bodies in MV3. |
| A service worker on a real web origin | Needs a Ghostly-operated website in the path. |
| **`chrome.debugger` Fetch domain on a virtual origin** | **Chosen.** |

Ghostly opens a tab, attaches the debugger to **that tab only**, and intercepts requests matching `https://*.invalid/*`. Each one is answered with the response the peer sent over WebRTC. The application runs on `https://<service>.<peer key>.invalid`:

- a normal, secure-context web origin, isolated from the extension and from every other peer and service;
- each peer is a site of its own (`.invalid` is a top-level domain to the browser), so one peer's app cannot set cookies for another's, and is cross-site to it;
- the tab serves only the service it was opened for: requests from it to any other peer or service are refused;
- `.invalid` can never resolve, so a request that is not intercepted goes nowhere;
- requests to any other origin (CDNs, APIs) are not touched;
- the debugger detaches when the tab leaves the virtual origin or closes.

The cost is Chrome's "Ghostly started debugging this browser" banner while such a tab is open.

### What works, what does not

Works: HTML, CSS, scripts (inline, classic, ES modules, dynamic `import()`), images, fonts, `fetch`/XHR with any method and binary bodies, redirects, in-app navigation and history, `localStorage`/IndexedDB per peer and service, large downloads (up to 32 MiB per response).

Does not work yet:

- **WebSockets**, including dev-server hot reload. The Fetch domain does not see them.
- **Streaming responses** (server-sent events, progressive downloads). The wire protocol streams, but a response is handed to the page once it is complete.
- **HTTP cookies with a browser host.** `fetch` can neither send `Cookie` nor read `Set-Cookie`, so cookie sessions do not survive a browser host. Token headers (`Authorization`) do. The protocol carries cookies; a Desktop host will forward them.
- **Service workers** of the remote application: their requests do not belong to the tab.
- Applications that hard-code `http://localhost:…` URLs. Those resolve on the visitor's machine. Relative URLs are fine.
- Applications that reject the `chrome-extension://` `Origin` on non-`GET` requests (strict CSRF checks).
- Incoming calls ring only while a Ghostly tab is open.

## Security notes

- **Reachability.** Only linked peers, authenticated by the link key and their Pkarr signature; the WebRTC session is bound to that identity through the signed DTLS fingerprint.
- **The proxy boundary.** Loopback-only targets, service ids instead of URLs, path confinement, no redirects off the target, no host credentials, header hygiene, and limits on body size, concurrency and time. The rules are in the [protocol](PROTOCOL.md#64-ghostly-http1) and covered by tests in `packages/core/test/http.test.ts`.
- **Remote code** runs in its own web origin, never in the extension's.
- **Camera and microphone** are requested by the page when you place or answer a call, never in the background.
- **Relays, STUN, TURN** see ciphertext only and hold no state about you.
- A service you share is as exposed to your peers as it is to you on `localhost`. Share applications you would let those peers use.

## Desktop

Ghostly Desktop runs this same peer in its WebView, as a third host (`src/desktop/host.ts`), with Rust doing what a WebView cannot:

| Core interface | Browser | Desktop |
|---|---|---|
| `PkarrTransport` | `RelayTransport` (HTTP relays) | `publish_records` / `resolve_records` on the Rust Pkarr client: the Mainline DHT directly, plus its relays, at Desktop's original poll timings |
| `LocalFetch` | `fetch` with a host permission | `local_fetch` in Rust: loopback only, never follows redirects, forwards cookies, no `Origin` header |
| viewer | `chrome.debugger` on a virtual origin | a window per service on a `ghostly-svc://<service>.<peer>` origin; requests go through the peer in the main window, and the window has no access to Tauri commands |

Checked by hand on macOS against the extension, both ways: chat, the WebRTC link (WebKit ↔ Chromium), a 3 MiB file, test sats, opening a service the extension shares, and sharing a local app that the extension opens. Not checked yet: Windows and Linux (WebKitGTK builds often ship without WebRTC), and calls between Desktop and the other clients.

Profiles (`GHOSTLY_PROFILE`) get their own sessions, database and peer, so two instances can run side by side.
