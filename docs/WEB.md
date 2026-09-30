# Ghostly on the web

The same peer and the same UI as [Ghostly Browser](BROWSER.md), running in a tab. Nothing to install: open the page and you are a Ghostly peer until you close it.

## Run it

```bash
docker compose up --build -d
```

Then open <http://localhost:8080>. `docker compose down` stops it. Releases also publish the image (`ghcr.io/miguelmedeiros/ghostly-web`): `docker compose pull && docker compose up -d` runs it without building. GIF search uses GifCities (Internet Archive) without an API key.

Without Docker:

```bash
npm install && npm run dev -w @ghostly/web
```

serves it on <http://localhost:5180> with hot reload, and `npm run build:web` writes the static site to `apps/web/dist`.

To put it behind a tunnel or a reverse proxy, choose where it listens with `GHOSTLY_WEB_BIND` (for example `GHOSTLY_WEB_BIND=0.0.0.0:8090 docker compose up --build -d`) and terminate HTTPS in front of it.

What is served is static files (nginx, `apps/web/nginx.conf`). There is no Ghostly backend: the peer runs in the visitor's tab, reaches Pkarr through relays, talks to contacts over WebRTC or Iroh through a relay (HyperDHT too, once a HyperDHT relay is set), and keeps its state in that browser's IndexedDB and localStorage. It needs a secure context, which `http://localhost` is; anywhere else, serve it over HTTPS.

Its log names no one: each request is one line with the time, the method, the file served, the status, the size and the time taken. There is no IP address, browser, referrer or query string, and error lines (which would name the client) are kept to `crit`. Docker keeps three files of 10 MB of it (`docker compose logs web`).

`npm run test:e2e` checks every feature of the web app in real browsers, and the web app against the extension ([e2e/README.md](../e2e/README.md)). `E2E_WEB_URL=https://app.ghostly.tools npx playwright test -c e2e/playwright.config.ts --project=web` runs the same tests against a deployed copy.

## How it shares code

```
apps/ui              the UI (Desktop's, unchanged)
packages/core        the protocol
packages/react       hooks shared by every client
packages/browser     the peer: engine, wallets, IndexedDB, and the stand-ins
                     for the six Desktop modules that touch the platform
apps/extension       host: peer in an offscreen document, Chrome permissions, viewer tabs
apps/web             host: peer in the page, one tab at a time
apps/ui/src/desktop + apps/desktop
                     host: peer in the WebView, Rust for the DHT, native Iroh, the HyperDHT sidecar, local apps, viewer windows
```

A host (`packages/browser/src/host.ts`) is the small part that differs: how a page reaches the peer, whether the user can grant access to local addresses, how a contact's web app is opened. All three build `apps/ui/src/` with the same Vite plugin (`packages/browser/vite-plugin.ts`).

## On a phone

Below 768px the app shows one screen at a time, like a messenger: the chat list, then the conversation with a back arrow, and a bottom bar for Chats, Wallets, Identities, Services and Settings. Emoji, GIFs and payments open as bottom sheets, calls take the whole screen, and the layout follows the visible viewport so the message input stays above the keyboard.

It installs to the home screen and runs in a window of its own: see [Install it](#install-it).

Screen sharing needs `getDisplayMedia`, which phone browsers do not have; the call's Share screen button does not show there. Elsewhere it is in every connected call, voice or video (there is no button for it in the chat header).

## Install it

The web app is an installable app (a PWA). Everything below is behind feature detection: a browser without one of these APIs runs the app as a plain page.

- **Install.** Chromium browsers (Chrome, Edge, Brave, Android) offer it, and the app shows it where people look: **Install app** in the account menu (the profile switcher over the account bar, or holding Settings on a phone), **Install** at the top of Settings, and once the app has been used a little (a chat of its own, or a second visit), a hint above the chat list. *Not now* puts the hint away for good in that browser; Install stays in the menu and Settings. Install shows the browser's own dialog. Safari has no such dialog, so Install shows the steps instead: on iPhone and iPad, Share, then *Add to Home Screen*; on a Mac (Safari 17 and later), File, then *Add to Dock*. Firefox cannot install web apps, and gets none of this. Installed, it all goes, and the app opens in a window of its own, portrait on phones.
- **Offline.** A service worker (`apps/web/src/sw/`, built into `/sw.js` by `apps/web/pwa.ts`) keeps the build's own files: the page, the hashed JavaScript and CSS, sounds, icons and the manifest, precached at install, and a wallet's WebAssembly once it has been loaded. Offline, the app still opens and shows every chat (they live in this browser already), with **Offline** above the chat list; nothing goes out until the network is back.
- **What it never caches.** Only those build files enter its cache (`apps/web/src/sw/policy.ts` is an allowlist): never a message, a relay or DHT answer, a mint, wallet or provider API, another origin, `/version.json`, the sign-in callback, or a request with a query. An invite's keys ride in the address's fragment, which the cache never keys on: every address of the app is the same cached page.
- **Share to Ghostly.** Installed, Ghostly is a share target: text, links, pictures and files shared from another app open **Share to…**, a list of chats. The chat picked opens with the text in the draft and the files on the attachment sheet (the one a paste opens), to look over and send there. The service worker holds what was shared in memory until the app asks for it, and drops it after two minutes; it is never written to a cache. Groups take text only, as files are not part of groups yet.
- **`web+ghostly:` links.** Installed from a Chromium browser, the app handles `web+ghostly:` links: `web+ghostly:ghostly1…` opens the invite like an `app.ghostly.tools/#ghostly1…` link, and leaves the address the same way.
- **Shortcuts.** The icon's menu (long press, or right click on the dock or taskbar) has **New chat**, **Scan invite** (Join with the camera on) and **Wallets**.
- **Badge.** The icon shows the number of unread messages where the system has badges (installed Chromium apps, iOS 16.4 and later with notifications allowed). A muted chat's messages do not count, like its sound and notification; a group counts one while it has something new.
- **Lock screen controls.** A voice message or an audio file playing shows on the lock screen and in the system's media controls (Media Session), which play, pause and seek it, and go to the next voice message.
- **Screen on during calls.** A call keeps the screen from dimming (Screen Wake Lock), asked again each time the app comes back to the foreground.
- **Woken while closed.** **Settings → Notifications → Wake me while closed** shares a push subscription with each paired contact, so a message sent while the app is closed shows "New message", nothing more, and a tap opens the chat. The sender's own app posts the push (no server of Ghostly's); muted chats stay quiet.
  - **Calls** too: a contact who calls while the app is closed wakes it, and it shows **Incoming call** until you answer or dismiss it. A tap opens the chat, and the call rings once it is live. The caller waits up to 60 s.
  - **Where:** Chrome, Edge and Firefox, and on iPhone and iPad only the app added to the Home Screen, from iOS 16.4. The desktop app and the extension keep running on their own, so they only wake others.
  - **Groups:** in a private group, a message that mentions you wakes the app and opens the group. Never `@everyone`, at most once every 5 minutes, and never in a group you muted. Communities do not wake anyone yet.
  - **Push relay.** A browser can post to some push services only through a relay, set in **Settings → Network → Push relay (optional)**, empty by default. `services/push-relay` is a reference one; none is run by Ghostly. The desktop app and the CLI post directly.
  - **New address** makes a fresh subscription, so nobody you stopped talking to can wake you. Deleting or muting a contact does the same by itself, and your other contacts get the new one. Deleting a profile ends its subscription. What the push service, a relay and contacts learn: [WISP 401 § Wake-up push](wisps/401-paired-chat.md#wake-up-push).
- **Not here.** Opening files with Ghostly from the file manager (`file_handlers`, desktop Chromium only) is left out: the app has no use for a file it did not receive in a chat.

## What a web page cannot do

| | Web | Extension | Desktop |
|---|---|---|---|
| Chat, files, payments | ✅ | ✅ | ✅ |
| Calls | ✅ | ✅ | ✅ (Linux: native media, no screen sharing yet) |
| Mainline DHT | through relays | through relays | directly |
| Iroh, HyperDHT | through a relay (HyperDHT only when one is set) | same as web | native |
| Runs while no window is open | no, the peer is the tab | yes, until the browser closes | yes, until the app closes |
| Share a local web app | ❌ | ✅ | ✅ |
| Open a contact's web app | ❌ for now | ✅ | ✅ |

- **Sharing a local app** means fetching `http://localhost:…` from the page. Browsers only allow that when the local app opts in with CORS (and Private Network Access) headers, and there is no permission a page can ask for. The UI says so instead of offering a button that would fail.
- **Opening a contact's app** needs an origin for it that is not Ghostly's own, or the app could read your keys and ecash. The extension makes one up per service; on the web that takes a wildcard subdomain with a service worker on each, bridged to the peer in the app's tab. It is static hosting, no backend, and not built yet. The button explains itself meanwhile.
- **One tab.** Two tabs would publish under the same keys and spend from the same wallet at once, so the peer takes a Web Lock and a second tab waits for the first to close.
- **Trust.** An extension is a package you installed once. A web page is code a server hands you on every visit; whoever controls that server controls your keys and your wallet. Host it yourself, or use one you trust.

## Keeping up to date

The build writes `/version.json` next to the app, and a tab asks for it on load, every four hours and whenever it comes back to the foreground. Different version, or the same version from a different commit, and the app offers a reload, never on its own, because reloading ends the peer and every call it holds. The question goes to the origin serving the app and to nobody else, and **Settings → Updates** turns it off.

The service worker keeps the version it was built with, so a deploy never swaps the app under a running chat, and reloading the tab on its own reloads the same version. The browser fetches the new `/sw.js` when a tab loads, and at once when the version check finds a deploy; the new worker installs beside the old one and waits. **Reload** on *New version* tells it to take over, then reloads into the new build, and the old version's cache is deleted. Once no tab of the app is left, the waiting worker takes over by itself, so the next start is the new version. Before there was a worker, no cached copy existed to go stale; now the explicit Reload is what keeps a tab and the server in step.

Self-hosting works the same way: `/version.json` is whatever you built, so your visitors are told about your deploys, not about ours.
