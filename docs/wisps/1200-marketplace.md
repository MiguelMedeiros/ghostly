# WISP 1200: Apps and Plugins: Packages, Stores and Apps Sent in a Chat

| Field | Value |
|---|---|
| Candidate number | 1200; editorial family allocation (1200-1299, Apps and plugins), accepted by the owner on 2026-10-06 |
| Status | Draft |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [02](02-peer-keys.md), [03](03-capabilities.md), [04](04-profiles.md), [05](05-backups.md), [06](06-devices.md), [200](200-payments.md), [300](300-peer-proofs.md), [310 did:dht](310-did-dht.md), [307 SSH](307-ssh.md), [400](400-chat.md), [401](401-paired-chat.md), [405 status cards](405-status-cards.md), [406 message buttons](406-message-buttons.md), [500](500-files.md), [501](501-paired-files.md), [700](700-local-services.md), [701](701-http-services.md), [800](800-invite-join.md), [1100](1100-headless.md) |
| Implementation | Accepted for release 1.2 on 2026-10-06; implementation is starting, behind a feature flag on `dev` until the web chess e2e passes. Nothing of it is in a release |
| Summary | Install apps and games by others from a store, a pasted Git URL or a chat. Each is checked against its publisher's signature and runs in a sandbox. |
| Availability | Planned |
| Notes | Not in the app yet. Phase 1, for release 1.2, is free mini-apps, turn-based and light versus games included, played live in a 1:1 chat, on the web app and Desktop; the extension comes later. No payments, no network access for apps. |

> This is a review draft. Candidate numbers and new record formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md) and [implementation evidence](IMPLEMENTATION.md).

Number note: the owner accepted the new family 1200-1299, "Apps and plugins", on 2026-10-06, and this contract took the family's x00 number, 1200, as 100, 200 and 1000 did. It was `12xx` (file `12xx-marketplace.md`, which forwards here). No existing family fitted a store: the closest, [700](700-local-services.md) (local services), is about a contact opening an app that runs on your computer, not about installing code ([NUMBERING](NUMBERING.md), [00](00-process.md#process)).

## Purpose

The owner wants a marketplace, and chose its first goods: **apps and plugins for Ghostly**, games among the first. Not services, not physical goods. This document is the design, written before the code, which starts with release 1.2.

It answers, in order: what an app and a plugin are, and which kinds phase 1 carries; the package and its signatures; where an app runs on each client, and its sandbox; how apps are found without a central server; paying, later, without an account; reviews; the threats; the phases.

The point of the design is that **no single source is required**. Ghostly's default store is one repository among many: a pasted Git URL, someone else's store and an app a friend sends in a chat install the same way, with the same checks.

## Goals and non-goals

In scope:

- Free mini-apps (games, polls, shared tools), installed from a pasted Git URL, a store or a chat, in phase 1.
- A package format, signatures and updates that do not trust the host the bytes came from (GitHub, a mirror, a contact).
- Stores anyone can publish, several at once, chosen by the person.
- A design for paid apps, licences, reviews and takedowns that needs no Ghostly server and no account.

Out of scope, on purpose:

- **Adapter plugins from a store.** A wallet source or an identity proof runs inside the engine with every key ([SDK.md](../SDK.md#trust-model-first)). Nothing that runs there is installed from a store until a permissioned plugin host exists (research, [Phases](#later-phases-and-research)).
- **DRM.** A package published in a public Git repository can be copied. A licence gates what an honest client does, not what a determined person does ([Paying](#paying-phase-2)).
- **Services and physical goods.** The roadmap's "Marketplaces / hosting example" row stays a later product question.
- **A Ghostly account or a store server.** There is none today, and this design adds none. Phase 1 runs no service at all: stores are signed files.

## Decisions taken by the owner (2026-10-03)

| Question | Decision |
|---|---|
| Paid apps | Free only for now. [Paying](#paying-phase-2) stays a phase 2 design |
| Default store | Apps are added by pull request to one repository. The owner holds its signing key, offline |
| An app sent in a chat that no store lists | Installable, with "Not in any of your stores" on its card |
| Extension | Build the extension path. If the Chrome Web Store objects, ship the extension without apps; web and Desktop keep them. Replaced on 2026-10-06: the extension comes after phase 1 |
| Network access for apps | None in phase 1. Later, an exact list of sites shown at install |
| Default index | A signed static file in the default store's repository, read directly by the client. No service to run. A self-hosted indexer stays optional, for people who want their own. On 2026-10-06 the crawler that builds it moved to release 1.3 |

## Decisions taken by the owner (2026-10-06)

Taken when the owner accepted this WISP for release 1.2. Where one changes an answer of 2026-10-03, the older row says so.

| Question | Decision |
|---|---|
| Number | The new family 1200-1299, with this contract as 1200 |
| The wire frame | `paired-app`, named like the session's other frames, on the session capability `apps/1`. Its data is at most **32 KiB** per frame. The session's limit for any control frame, 60 KiB (`LIMITS.maxControlFrameBytes`), still holds above it and does not change ([In a chat](#in-a-chat-apps1)) |
| Playing while not both online | **Live only** in phase 1. Each side keeps the app's state per chat, and the app catches up when the session comes back. No moves as messages, nothing on the DHT, nothing held |
| Names | The feature, its page and its button are **Apps**. The existing dialog where a contact's shared apps open (`services/1`, [700](700-local-services.md)), titled "Apps with <name>" today, is renamed **Shared services** |
| Default store | A **repository of its own**, separate from Ghostly's, so its pull requests and takedowns stay apart from the app's. Its store key is held offline by the owner |
| First-party mini-apps | Built in Ghostly's repository (Chess in `apps/mini/chess`) and signed by a **publisher key distinct from the store key**. The store key lists apps and never signs one |
| jsDelivr | Allowed as a source, **only pinned to a commit** ([Stores](#stores)) |
| Desktop | **In phase 1**: an `app-*` window per app on the `ghostly-app` scheme. If the Desktop spike finds a problem, the problem gets fixed; release 1.2 does not ship web-only |
| Extension | **Later**, after a test submission passes the Chrome Web Store review. Until then the extension shows no Apps |
| Discovery in release 1.2 | The default store, a store added by its URL and an app added by its URL or from a card. The crawler and the default index come in release 1.3 (the coordinator's default, not objected) |
| Rollout | Behind a feature flag on `dev` until the web chess e2e passes |

## What exists today (evidence)

Each fact was checked against the file it names on `dev` on 2026-10-02, or measured in the reviews of 2026-10-03. Where one is wrong, the section that cites it must change.

| Fact | Where |
|---|---|
| The SDK exists in the repository, not on npm. A plugin is a plain object naming adapters of three kinds: Lightning sources, on-chain sources and identity proofs. Transports have no registration | `packages/sdk`, `packages/browser/src/plugins/registry.ts` (`GhostlyAdapterPlugin`, `SDK_API = 1`), [SDK.md](../SDK.md#transports-and-a-minimal-client) |
| An adapter runs with the app's privileges: it can read every key, sign anything, spend everything and reach any network the page can. No sandbox, no permission prompt, no signature check, no store | [SDK.md](../SDK.md#trust-model-first), `packages/browser/src/plugins/registry.ts` |
| Plugins enter only at build time (`GHOSTLY_PLUGINS`, read by the Vite plugin) or from code already in the engine's realm (`registerAdapters`); "there is no way to load a plugin from a URL, a file or a store, on purpose" | `packages/browser/vite-plugin.ts`, `packages/browser/src/plugins/bundled.ts`, [SDK.md](../SDK.md#registration-a-plugin-not-a-registry-line) |
| Release builds bundle no plugin, by omission: the release workflow never sets `GHOSTLY_PLUGINS`; only the e2e configurations do | `.github/workflows/release.yml`, `e2e/playwright.config.ts` |
| Shared apps (`services/1`) let a contact open an app running on your computer, proxied over the chat's live link. Desktop opens it in a window of its own on the `ghostly-svc` scheme, maps the window's label to its state, blocks navigation (`on_navigation`) and denies new windows; the extension uses a tab on `https://<service>.<peer>.invalid/` answered through `chrome.debugger`; the web app can do neither | [700](700-local-services.md), [701](701-http-services.md), `packages/core/src/pairedHttp.ts`, `apps/desktop/src/viewer.rs`, `apps/extension/src/background.ts`, [BROWSER.md](../BROWSER.md#opening-a-contacts-app) |
| On Desktop only the `main` window may call commands; every other window is refused, whatever the capabilities say, and a test checks it. Tauri injects its IPC bridge into every window's main frame, so "no IPC" means "every command refused", not "no bridge" | `apps/desktop/src/main.rs` (`only_main`), `apps/desktop/capabilities/default.json` (`windows: ["main"]`); Tauri 2.12 `manager/webview.rs` (read in the product review) |
| The app renders no iframe anywhere, and no element with `sandbox` | `apps/ui/src` (no match), `apps/ui/src/test/chat/linkPreview.test.tsx` asserts a preview makes none |
| Every client's CSP: web `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https: wss: …; frame-ancestors 'none'`, included in every nginx location; extension pages `script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; img-src …`; Desktop like the web plus `ipc:` and loopback. None sets `frame-src` or `child-src` | `apps/web/nginx-headers.conf`, `apps/web/nginx.conf`, `apps/extension/public/manifest.json`, `apps/desktop/tauri.conf.json`, `apps/ui/src/test/security/contentSecurityPolicy.test.ts` |
| The web app's service worker serves only its own build files and passes any other path, such as a new `/app-frame.html`, to the network, so a header the server sets on it holds | `apps/web/src/sw/policy.ts` (`classify`) |
| The extension is Manifest V3 with no `sandbox` pages and holds the `debugger` permission; the engine runs in an offscreen document | `apps/extension/public/manifest.json`, `apps/extension/src/background.ts` |
| Desktop updates are signed: the Tauri updater checks a minisign signature against a public key in the configuration | `apps/desktop/tauri.conf.json` (`plugins.updater`) |
| Cards under a message (invite, group, Nostr, identity) come from a parser of the text; at most 3 per message. Sender-made link previews ride with the message so the receiver fetches nothing to show them | `apps/ui/src/lib/parse/entities.ts`, `apps/ui/src/components/chat/EntityCards.tsx`, `apps/ui/src/lib/parse/linkPreview.ts`, [401](401-paired-chat.md) |
| A structured card (`sc`, at most 8 KiB, text as fallback) rides beside the text on every text path; today only bots send them | [405 status cards](405-status-cards.md), [406 message buttons](406-message-buttons.md), `packages/core/src/statusCards.ts` |
| `files/3` carries a file of any size with consent and resume; the receiver takes up to 25 MiB by itself and checks the SHA-256 of what it stored | [501](501-paired-files.md#files3-files-of-any-size-revision-03), `packages/browser/src/shared/fileBytes.ts` |
| A `ghostly1` invite pairs exactly one chat: after the first pin another key is ignored | [800](800-invite-join.md#baseline-and-purpose) |
| The only profile-wide key is the DID key (did:dht), an Ed25519 key made from the DID seed. No chat uses it; it travels in backups. WISP 06 derives the first device-set secret from the same seed | [310 did:dht](310-did-dht.md), `packages/browser/src/engine/did.ts`, [06](06-devices.md#terms) |
| The GitHub SSH proof checks a key against `api.github.com/users/<login>/keys` | `packages/browser/src/proofs/sshForges.ts`, [307 SSH](307-ssh.md) |
| Payments in a chat: `pay-req`, `pay`, `pay-res` frames; Testnet has a faucet button; any Mainnet spend needs `confirmedReal` | [200](200-payments.md), `packages/core/src/frames.ts`, `packages/browser/src/engine/paymentAdapters/testCoins.ts`, `walletInstances.ts` (`assertConfirmedReal`) |
| A control frame of the live session is at most 60 KiB; a larger one is dropped before it is read | `packages/core/src/frames.ts` (`LIMITS.maxControlFrameBytes`), `packages/core/src/ghostlink.ts` (`onApplication`) |
| The headless CLI is on npm as `@ghostlytools/cli`; small self-hosted services live in `infra/services/` | `packages/cli`, `.github/workflows/npm-publish.yml`, `infra/services/` |
| Nothing in the code is a store, a package or a mini-app. They exist only as roadmap rows | [ADAPTER-ROADMAP.md](ADAPTER-ROADMAP.md#plugins-apps-catalogs-and-ghostlyos) |

**Measured in the product review (2026-10-03; Chromium 145, Playwright 1.58, curl 8.7):**

| Test | Result |
|---|---|
| A frame `sandbox="allow-scripts"` with `connect-src 'none'`: fetch, beacon, WebSocket, EventSource, a worker's fetch, images, CSS, fonts, media, prefetch, preload, forms, popups, `top.location` | All blocked |
| The same frame, WebRTC | **Got out**: STUN packets to a host and port the frame chose, on web and in the extension. CSP's `webrtc 'block'` was ignored |
| Deleting `RTCPeerConnection` and its relatives in the frame before other code runs | Closed it; no fresh copy came back through an `about:blank` or `srcdoc` frame |
| The frame navigating itself (`location=`, meta refresh, a link) | **Got out** when the parent page had no `frame-src`; closed by `frame-src 'self'` on the parent (extension tested) |
| Relative imports inside a module loaded from a `blob:` URL; relative image and CSS URLs | Broken |
| An extension sandbox page with `blob:` and `'wasm-unsafe-eval'` in its CSP | Loaded; WebAssembly ran; `eval` blocked; no `chrome.runtime`; storage APIs refused |
| From another origin: `raw.githubusercontent.com` (commit or `HEAD`), jsDelivr `@commit`, `api.github.com` | Readable (CORS `*`); raw caches 5 minutes, jsDelivr is immutable, the API allows 60 an hour |
| From another origin: `codeload.github.com`, release assets | Not readable (no CORS) |

Measured since, by the Desktop spike (2026-10-06, WKWebView on macOS 15.6, see [Per client](#per-client)): a CSP `sandbox` header sent by a Tauri custom scheme is honoured, every channel above is closed, and two are not closed by the policy in WebKit: `<link rel=preconnect>` opens a connection, and a `srcdoc` frame brings its own `RTCPeerConnection`. Not measured yet: WebKitGTK (Linux), WebView2 (Windows), and DNS prefetch and preconnect from the web frame (Chromium).

## What the outside world allows (sources)

Read on 2026-10-02. Each line names the page it rests on.

| Fact | Source |
|---|---|
| **Umbrel's store** is a Git repository with one folder per app holding `umbrel-app.yml` and `docker-compose.yml`. The manifest has `manifestVersion`, `id`, `category`, `name`, `version`, `tagline`, `description`, `releaseNotes`, `developer`, `website`, `dependencies`, `repo`, `support`, `port`, `gallery`, `submitter`, `submission` | [umbrel-apps packaging guide](https://github.com/getumbrel/umbrel-apps/blob/master/.agents/skills/umbrel-package-app/SKILL.md), [bitcoin/umbrel-app.yml](https://raw.githubusercontent.com/getumbrel/umbrel-apps/master/bitcoin/umbrel-app.yml) |
| Umbrel's official store takes apps by pull request, linted and reviewed by its team | the same guide, "PR Readiness" |
| A **Community App Store** is a Git repository with `umbrel-app-store.yml` (`id`, `name`), added by pasting its URL. Umbrel installs stores only, never a single app's URL | [umbrel-community-app-store](https://github.com/getumbrel/umbrel-community-app-store) |
| Umbrel clones the default branch shallowly and re-clones when the remote head changes, every 5 minutes. **It checks no signature and pins no commit.** Its UI warns that community stores are not vetted | [app-repository.ts](https://github.com/getumbrel/umbrel/blob/master/packages/umbreld/source/modules/apps/app-repository.ts), [app-store.ts](https://github.com/getumbrel/umbrel/blob/master/packages/umbreld/source/modules/apps/app-store.ts), [en.json](https://github.com/getumbrel/umbrel/blob/master/packages/ui/public/locales/en.json) |
| **Chrome Web Store, MV3:** remotely hosted code may not run in the extension; remote data may. Code run "in contexts that are isolated from extension APIs (such as iframes and sandboxed pages)" is exempt | [Remote hosted code](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code), [MV3 requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements) |
| An extension's **sandbox pages** get no extension APIs, talk by `postMessage` only, run under their own CSP, which must keep `sandbox` and may not add `allow-same-origin` | [manifest sandbox](https://developer.chrome.com/docs/extensions/reference/manifest/sandbox) |
| **Tauri 2:** the API is limited to bundled code by default. On Linux and Android Tauri cannot tell a request from an embedded iframe from one by its window. Custom schemes are `<scheme>://localhost/` on macOS and Linux, `http://<scheme>.localhost/` on Windows | [Capabilities](https://v2.tauri.app/security/capabilities/), [tauri::Builder](https://docs.rs/tauri/latest/tauri/struct.Builder.html) |
| A sandboxed iframe without `allow-same-origin` has an opaque origin, reported as `"null"`: no cookies, no `localStorage`. The CSP `sandbox` directive works only as an HTTP header | [MDN iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe), [HTML sandboxing](https://html.spec.whatwg.org/multipage/browsers.html#sandboxing), [MDN CSP sandbox](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox) |
| **jsDelivr** keeps commit-pinned files even after the repository is deleted; single files over 20 MB are not served | [jsDelivr README](https://github.com/jsdelivr/jsdelivr) |
| GitHub disables a repository about one business day after a DMCA notice that is not resolved; it has been blocked by governments at times | [DMCA takedown policy](https://docs.github.com/en/site-policy/content-removal-policies/dmca-takedown-policy), [Censorship of GitHub](https://en.wikipedia.org/wiki/Censorship_of_GitHub) (secondary) |
| **TUF** has four roles (root, targets, snapshot, timestamp) and addresses rollback, indefinite freeze, mix-and-match, malicious mirrors and key compromise below a threshold | [TUF specification](https://theupdateframework.github.io/specification/latest/) |
| **F-Droid** signs its index offline, with an expiry; a repository is defined by its signing key; third-party repositories are added by URL. **Zapstore** has each release signed by its developer's key | [F-Droid security model](https://f-droid.org/docs/Security_Model/), [zapstore.dev](https://zapstore.dev/) |
| Offline licences: Keygen's signed licence files and L402's paid preimage. Neither binds a licence to the buyer's public key | [Keygen cryptography](https://keygen.sh/docs/api/cryptography/), [L402](https://docs.lightning.engineering/the-lightning-network/l402) |

## Terms

| Term | Meaning |
|---|---|
| **Publisher** | Whoever signs a package. Identified by an Ed25519 **publisher key**, nothing else |
| **Package** | One version of one app, published as one file, the **bundle** (`.ghostlyapp`): a signed manifest and the files it lists |
| **App reference** | `<publisher key>/<name>`. Two packages are versions of the same app only when both are signed by the same publisher key and carry the same name |
| **Digest** | SHA-256 of a package's canonical manifest, which lists the SHA-256 of every file. One digest names every byte of a version |
| **Source** | Anywhere a bundle can come from: a Git repository, a mirror, a store's copy, a file in a chat. Sources are not trusted: bytes are checked against the signature and the digest |
| **Store** | What people see: a list of apps they chose to browse. Technically, a **signed store index** at an HTTPS URL. A **curated** store is a list someone chooses (a catalog, kept in a Git repository); an **indexed** store is the same file built by a crawler over many catalogs and repositories (an indexer's output). The client treats both alike and shows which is which |
| **Runner** | The small trusted page that hosts one app in its sandbox |
| **Broker** | The client code, outside the sandbox, that answers an app's requests within the permissions the person granted |

**Names in the app.** The feature, its page and its button are called **Apps**. The dialog where a contact's shared apps (`services/1`, [700](700-local-services.md)) open, titled "Apps with <name>" today, becomes **Shared services**, so the two never share a word. Wire names do not change: `services/1` stays.

**An app is never identified by a store.** Its reference is bound to its publisher key, so a lying store can hide an app or rank it, never swap code of an installed app.

## What an app and a plugin are

| Kind | What it is | Runs | Phase 1 | Why |
|---|---|---|---|---|
| **Mini-app** | A static web app in one self-contained HTML file (scripts, styles, images and WebAssembly inline). Alone, or in a chat with the same app on the contact's side | In the runner's sandbox, talking to the client only through the broker | **Yes** | It needs no key, no wallet and no engine object, and the browser's sandbox can hold it, with the fixes below |
| **Theme** | Colours and design tokens as data | Read by the client | No: phase 2 | Publishing themes is a public promise about the app's design tokens, which still change. When it comes, a theme is typed values only (colours, sizes), never raw CSS, since a CSS `url()` would reach the hosts in the main page's `img-src` |
| **Bot** | A program for the headless CLI ([1100](1100-headless.md)) | As a process on a server | No: phase 3 | Native code needs an operating-system sandbox |
| **Adapter plugin** | A wallet source or an identity proof built with the SDK | In the engine, with every key | No: research | It has the app's privileges. Stays a build-time choice until a permissioned plugin host exists |
| **Transport** | A new way to connect | In the engine | Never a store item | A transport is a WISP and an app change |

So **phase 1 carries mini-apps**. "Plugin" in this document means an adapter plugin; the word stays in the family's name because adapter plugins join the same package and store format once they can run safely.

### Games

Games are among the first apps the owner wants. The design rules none out; each kind needs this:

| Kind | Examples | Needs | Phase |
|---|---|---|---|
| Turn-based, open | Chess, checkers, go | `apps/1` in a 1:1 chat, as written ([In a chat](#in-a-chat-apps1)) | **1** |
| Turn-based, hidden information | Battleship, card games | The same, plus **commit-reveal** in the app: each side sends the SHA-256 of its secret state with a random 32-byte salt first, and reveals state and salt only when the rules say, so the other side checks the reveal against the commitment. Neither side can read or change the other's hidden state unseen. The template ships a helper; the client enforces nothing here | **1** |
| Light real-time, versus | Tetris versus (cleared lines sent to the opponent), Snake versus | Ordered `apps/1` as it is: each side runs its own game and sends little (a few events a second, well under the 50 a second limit) and tolerates tens of milliseconds. Tetris versus keeps two separate boards and sends only garbage lines and a periodic score. Snake on one shared board runs in lockstep with a short input delay, and is smooth when the chat link is direct and laggy on a relay; the app measures the round trip itself with its own ping frames | **1**: these can be the first real-time apps, before the unordered mode exists |
| Real-time | Pong, Tron, a Quake-like | WebAssembly (`'wasm-unsafe-eval'` is in the runner's CSP on every client from phase 1); bundles up to 64 MiB, sent as files rather than in a card; an unordered, droppable message mode on `apps/1` over the live WebRTC data channel (never the DHT text floor), with higher receiver limits granted by the `realtime` permission shown at install | **2**: the unordered mode is new transport work (today's chat data channel is ordered and reliable, and the native transports are streams), so it is not cheap in phase 1 |
| Group games | Party games, a shared board for many | Group frames, after `apps/1` in groups | Later, with groups |

## The package

### The bundle, the one published unit

A package is published as **one file**, the bundle. The same file is what a store points at, what a contact sends in a chat and what a mirror keeps.

Bytes: `GHOSTLYAPP1`, then the canonical manifest, then the signature statement, each preceded by its length (32-bit, big-endian), then every file's bytes in the order of the manifest's `files`. The sizes in the manifest delimit the files; there is no archive format to parse and no path the manifest did not name. **A bundle with any byte past the last file is refused**, as is one that ends early.

| Bound | Phase 1 | Phase 2 (games) |
|---|---|---|
| Whole bundle | 16 MiB (under jsDelivr's 20 MB per file and the 25 MiB a chat takes without asking) | 64 MiB, with the `realtime` kind of app; fetched from raw GitHub (jsDelivr does not serve it) or sent as a file with consent |
| Files | At most 64: the entry, `icon.png`, up to 8 screenshots, and data files the app reads through the broker | The same |
| Manifest | At most 64 KiB | The same |
| Paths | Relative, `/`-separated, `[A-Za-z0-9._-]` per segment, no `.` or `..`, at most 128 bytes; no two equal ignoring case | The same |
| Icon | `icon.png`, square, at most 256 KiB | The same |

A client refuses a bundle that breaks any bound before it shows anything but the refusal.

**The entry is one self-contained HTML file.** Relative imports and relative URLs do not work inside the sandbox (measured), so the SDK's template builds the app single-file: scripts and styles inline, images as `data:` URLs, WebAssembly decoded in script or read from the bundle through the broker (`ghostly.file(path)`). Other files in the bundle are data, never loaded by URL.

### Manifest

UTF-8 JSON. Exact keys; an unknown key is refused, so a later version raises `ghostlyApp`. **The manifest's bytes in the bundle must be exactly its canonical form** ([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785), JCS): a client recomputes it and refuses a mismatch, so two parsers (JavaScript, Rust) can never read different values from one manifest, for example from a duplicated key.

| Field | Required | Meaning |
|---|---|---|
| `ghostlyApp` | Yes | Format version: `1` |
| `publisher` | Yes | The publisher key: Ed25519, 32 bytes, z-base32 |
| `name` | Yes | `^[a-z][a-z0-9-]{0,31}$`, unique per publisher |
| `version` | Yes | Semantic version ([SemVer 2.0.0](https://semver.org/)), at most 64 characters, shown to people |
| `sequence` | Yes | An integer from 1 to 2^53 - 1 that rises with every version. Rollback protection compares it, never `version`. The CLI raises it by itself |
| `kind` | Yes | `mini-app` in phase 1 |
| `title`, `tagline`, `description` | Yes, yes, no | 40, 80 and 2000 characters at most (Unicode code points). Title and tagline are one line of at least one character; the description may hold line feeds. No other control character in any |
| `entry` | Yes | The entry file, usually `index.html`: a path of `files` ending in `.html` |
| `permissions` | Yes, may be empty | [Permissions](#permissions): in phase 1 only `chat` and `name`, each at most once, in any order |
| `runtime` | Yes | `{"host": ">=1.2", "clients": ["web", "desktop"]}`, exactly these two keys. `host` is `>=MAJOR.MINOR` or `>=MAJOR.MINOR.PATCH`. The clients, at least one and each once, are `web`, `desktop` and, once it runs apps, `extension` |
| `license` | Yes | An SPDX expression (identifiers joined by `AND` and `OR`, `WITH` an exception, parentheses), or `proprietary`; at most 128 characters |
| `sources` | No | At most 8 HTTPS URLs where newer bundles of this app are published, in order (for GitHub, the `raw.githubusercontent.com/<owner>/<repo>/HEAD/app.ghostlyapp` URL) |
| `proofs` | No | Reserved for public proofs linking the publisher key to an identity people know ([Publisher identity](#publisher-identity)). **Phase 1 accepts it only absent or empty** (`[]`) and refuses any proof (`proofs-unsupported`) |
| `homepage`, `support`, `releaseNotes` | No | Two HTTPS URLs and 500 characters of one line |
| `files` | Yes | Every file: exactly `{"path", "size", "sha256"}`, sorted by path (byte order, no two equal), SHA-256 in base64url |

Reserved and refused in phase 1: `price` (phase 2) and `recovery` ([Keys](#publisher-keys-no-rotation-in-phase-1)).

**Every URL** of this WISP (`sources`, `homepage`, `support`, a store's `urls`, `repo` and `support`) is `https:`, at most 512 characters, with no user or password; on jsDelivr (`*.jsdelivr.net`) it is only `https://cdn.jsdelivr.net/gh/<owner>/<repo>@<commit>/<path>` with a full 40-character lowercase hex commit ([Stores](#stores)). **Paths:** a file under `screenshots/` is a screenshot (`.png`, `.jpg` or `.webp`, at most 8); `icon.png` is the icon (at most 256 KiB, a PNG whose header says it is square). Other files are data. **Keys** are 52 z-base32 characters that decode to 32 bytes and encode back to the same text; **hashes** are 43 base64url characters without padding that decode to 32 bytes and encode back to the same text, and a signature 86 that decode to 64.

### Signatures: one rule for every statement

Every signed object in this document is signed the same way: Ed25519 over the bytes `<prefix>` + a zero byte + the SHA-256 of the object's canonical JSON. The prefix says what the object is, so no signature can be replayed as another kind:

| Object | Prefix | Signed by | Phase |
|---|---|---|---|
| Package manifest | `ghostly-app/1` | Publisher | 1 |
| Store index | `ghostly-store/1` | Store key | 1 |
| Revocation | `ghostly-revoke/1` | Publisher | 1 |
| Publisher proof statement | `ghostly-publisher/1` | Publisher | Later: publisher proofs are not in phase 1 (2026-10-06) |
| Report | `ghostly-report/1` | Reporter | 2 |
| Review | `ghostly-review/1` | Reviewer | 2 |
| Licence | `ghostly-licence/1` | Publisher | 2 |
| Key rotation, recovery key | `ghostly-rotate/1`, `ghostly-recovery/1` | Publisher, recovery key | Reserved |

The signature statement in a bundle is `{"alg": "ed25519", "key": "<publisher key>", "sig": "<base64url>"}`: exactly these keys, its bytes canonical as the manifest's (at most 1 KiB), and `key` equal to the manifest's `publisher`. Signatures verify as RFC 8032 writes it (canonical encodings of the key, the point and the scalar), so two parsers accept exactly the same ones. A package is **valid** when the manifest is canonical and holds every bound, the signature verifies under `publisher`, and every file matches its size and hash. A client checks all of it before it stores a bundle, and the files again before it runs one. [Test vectors](#test-vectors) come before this draft is Proposed.

**Reading a bundle, in this order.** Every parser checks in the same order, so a broken bundle gets the same refusal code from each; the code in parentheses is the one the [vectors](#test-vectors) pin.

1. The whole is at most 16 MiB (`too-large`).
2. The first 11 bytes are `GHOSTLYAPP1` (`magic`; fewer bytes that match are `truncated`).
3. The manifest's length is at most 64 KiB (`manifest-too-large`), read before the manifest itself; then the manifest, the statement's length and the statement are there (`truncated`).
4. The manifest is UTF-8 JSON (`not-json`) whose bytes are its canonical form (`not-canonical`: whitespace, keys out of order, a duplicated key, `1.0`, a byte order mark).
5. Its fields: `ghostlyApp` is 1 (`unsupported-format`); no key outside the table (`reserved-key` for `price` and `recovery`, `unknown-key` for any other); every required key (`missing-key`); each field as the table says (`bad-field`), `proofs` empty (`proofs-unsupported`); at most 64 files (`too-many-files`); each path (`bad-path`, also a screenshot of another type), no two equal ignoring ASCII case (`path-collision`), sorted (`files-unsorted`); at most 8 screenshots (`too-many-screenshots`); the icon's size (`bad-icon`); the entry (`bad-entry`).
6. The statement is canonical JSON with exactly `alg`, `key` and `sig` and `alg` `ed25519` (`bad-signature-statement`).
7. The bytes after the statement are exactly the files' sizes added up: fewer is `truncated`, more is `trailing-bytes`.
8. The statement's `key` is the manifest's `publisher` (`signature-key`), and the signature verifies under `ghostly-app/1` (`bad-signature`).
9. Every file's SHA-256 (`file-hash`), in the manifest's order; then the icon's PNG header says it is square (`bad-icon`).

### Publisher identity

- A publisher key is **not a profile key**. The CLI makes and keeps it ([Publishing](#publishing-the-publisher-cli)), so a developer's chat profile never signs packages and a signing key never sits in a browser.
- **Later, not in phase 1** (the release 1.2 plan, 2026-10-06): publisher proofs and their `ghostly-publisher/1` statement are not built in phase 1, and a phase 1 client refuses a manifest whose `proofs` is not empty. Every phase 1 app shows its fingerprint, and "Unknown publisher" unless a curated store of the person's lists it. The design kept for then: `proofs` holds public proofs of [300](300-peer-proofs.md)'s kinds that work for anyone: the **GitHub SSH proof** (a `ghostly-publisher/1` statement signed with an SSH key GitHub publishes for the account, checked against `api.github.com/users/<login>/keys` as the existing proof does), and a domain proof. The CLI writes the GitHub one.
- **What people see, in this order:** the verified proof ("github.com/ana ✓"), then the publisher fingerprint: the first 16 z-base32 characters of the key (80 bits), in four groups (`7f3k q9ax 81mz c4tp`). With no proof that verifies and no **curated** store of the person's listing the app, the card says **"Unknown publisher"** instead of any "Signed" badge: anyone can sign with a throwaway key, so a signature alone says nothing to a person. Only a curated store clears "Unknown publisher" and "Not in any of your stores": an **indexed** store's listing (the default index included, though the owner signs it, because a crawler chose its entries) shows "Found by <index>" and leaves both warnings in place.
- A repository's URL alone proves nothing about the key.

### Publisher keys: no rotation in phase 1

Phase 1 has **one key per app and no rotation or recovery**. If a publisher key is lost or stolen, the publisher signs a revocation if it still can, starts a new app under a new key, and stores say so. Rotation is reserved (`recovery` and the `ghostly-rotate/1` and `ghostly-recovery/1` prefixes) for phase 2.

Why not the recovery key now: in the first draft it sat in the manifest, which the publisher key signs, so a thief of that key could name a recovery key of its own. The fix, a recovery key pinned at first install and changed only by a statement the current recovery key signs, is right, and phase 2 adopts exactly that. But it adds a key people must keep offline, a chain to verify and a screen to explain, before any publisher has a key worth recovering. One key per app is easier to get right first. The cost, said plainly: **an app installed in phase 1 can never pin a recovery key later**, because pinning one at an update has the same thief problem. Its publisher moves to a new app under a new key when it wants rotation.

**Revocation** (phase 1): a `ghostly-revoke/1` statement naming digests, or every version up to a `sequence`. The statement is `{"ghostlyRevoke": 1, "app": "<ref>", "digests": [...]}` (1 to 64 digests, each once) or `{"ghostlyRevoke": 1, "app": "<ref>", "upTo": <sequence>}` (every version with that `sequence` or a lower one), exactly one of `digests` and `upTo`, with an optional `"reason"` of one line of at most 200 characters, and no other key. A **signed revocation** is `{"statement": {...}, "signature": {"alg", "key", "sig"}}`, signed under `ghostly-revoke/1` by the key in the statement's `app`; a signature by any other key is refused (`signature-key`), as is a statement of another shape (`bad-revocation`). `ghostly-revoke.json` is a canonical JSON list of at most 4096 signed revocations, and one that does not verify refuses the file. **Published** in the app's repository as `ghostly-revoke.json` (a list of signed statements) next to `app.ghostlyapp`, and copied verbatim by stores into their index (`revoked`). **Read** at every update check from the app's `sources` and the person's stores; a client keeps every revocation it has verified. A client that sees one stops those versions with no "Run anyway".

### Updates and rollback

A client stores, per installed app, the publisher key, the highest `sequence` it has seen and the digest of that version.

- **An update is any valid package of the same app with a higher `sequence`.** Where it came from does not matter. The bytes are checked, not the messenger.
- **Rollback:** a lower `sequence` is never installed over a higher one. The same `sequence` with a different digest is **equivocation**: the client keeps what it runs, refuses the other and marks the app ("Two different versions 7 exist. Ghostly kept the one you have.").
- **Where the client looks:** the manifest's `sources` and the person's stores. Never at the contact who sent the app.
- **When:** only once at least one app is installed: at start and every 24 hours, and when the person opens the Apps page. A person with no app installed makes no request to any store or source, so the preloaded store does not see every client's address each day. Browsing the store list is a request the person makes.
- **Freeze** (every source serves an old version) is partly covered: a store index expires, so a frozen store is noticed; a frozen publisher repository is not, until a phase 2 publisher record (a Pkarr record under the publisher key naming each app's latest `sequence`).
- **Uninstall** removes the files and the app's storage after offering an export of that storage.

**Where installed apps live (phase 1).** Bundles are kept by digest in the client's file-bytes storage, the same store as chat files ([501](501-paired-files.md)); the installed list (reference, `sequence`, digest, permissions, stores added) and each app's storage, keyed by (app reference, scope), go in the profile's database. **Export** is a JSON file `{"ghostlyAppData": 1, "app": "<ref>", "scope": "<local chat id, or alone>", "entries": {...}}`. A **backup** ([05](05-backups.md)) carries the installed list, the stores and the app storage, not the bundles: a restored profile fetches each bundle again by digest from its `sources` or stores, and shows "Needs its files" until one answers. A **device handoff** ([06](06-devices.md)) moves the same state, and the bundles as files by digest, which the handoff already skips when the taking device holds them.

**TUF, evaluated:**

| TUF piece | What it gives | Taken here |
|---|---|---|
| Root role, threshold of keys | Survives a compromise of some keys | Not in phase 1; phase 2's pinned recovery key is a threshold of one, offline |
| Targets role | Which files, by hash | The manifest's `files` |
| Snapshot role | Stops mix-and-match | One package has one manifest; a store has one index |
| Timestamp role, short expiry | Detects freeze | Store index expiry; a publisher record in phase 2 |
| Delegations | A repository delegates to developers | A store lists packages signed by their publishers |
| Metadata format, client libraries | Interoperable, reviewed | No: it assumes one repository authority, and Ghostly has many publishers and stores. A smaller format of TUF's ideas, as F-Droid and Zapstore also chose |

### Permissions

A mini-app gets nothing by default but its frame and the broker. Phase 1:

| Permission | What the app may do | Shown at install as |
|---|---|---|
| none | Draw in its frame; keep up to 5 MiB of its own data, **separately per chat** it is opened in, and separately when opened alone | "Keeps its own data on this device" |
| `chat` | Exchange messages with the same app on the contact's side, in the chat where the person opened it, while the chat is live | "Talks to the same app on your contact's side" |
| `name` | Read the person's display name in that chat | "Sees your name in this chat" |

Storage is scoped per app and per chat so an app cannot carry data from one contact to another, or tie together the person's identities across chats.

**Every install screen also says**, whatever the permissions: "No internet access. The publisher may still learn your IP address and when you open it." The sandbox closes every channel the reviews found, but DNS prefetch on the web, WebKitGTK and WebView2 are not measured yet, and a contact in a `chat` app always learns when the app is used.

Later phases add, each with its own line: `network` (an exact list of HTTPS origins, shown at install and re-asked when one is added: the owner's answer), `realtime` (the unordered message mode and higher limits, for games), `cards` (read the task and routine cards the contact sent in this chat, for a bot's own app), `payment-request` (the client shows a payment the person approves; the app never sees a wallet), `clipboard-write`, `camera`, `microphone`, `notify`.

**What re-asks:** an update that adds a permission waits for the person, who sees only what is new; one that removes a permission applies by itself. **What never happens:** an app that runs before the person pressed Install; a permission granted by a store or a contact; a permission granted for all apps at once.

## Where it runs

### The runner and the broker

The runner is a small page **shipped inside the client**, never fetched. One runner hosts one app instance: two apps open at once are two runners.

**Starting an app:**

1. The client verifies the bundle and creates the frame (web, and later the extension) or window (Desktop).
2. The runner checks that it is where it should be, and refuses to start otherwise: its origin is `"null"` and it has a parent (web, and later the extension), or its window label starts with `app-` (Desktop).
3. The runner **deletes `RTCPeerConnection`, `webkitRTCPeerConnection`, `RTCDataChannel`, `RTCRtpSender`, `RTCRtpReceiver`, `RTCIceCandidate` and `RTCSessionDescription`** from its global object. This closes the WebRTC leak the review measured. `frame-src 'none'` blocks nested frames that have a URL, but not `about:blank` or `srcdoc` frames. Each of those gets an opaque origin of its own, so the runner's realm cannot reach their constructors (measured in Chromium and WebKit), but **the frame's own script has a fresh `RTCPeerConnection`**: in WebKit a `srcdoc` frame reached a STUN and a TURN server with the runner's policy in place (measured, Desktop spike). Deleting the constructors is therefore not the stop for nested frames. On Desktop the stops are `on_navigation`, which refuses `about:srcdoc` and `about:blank` frames, and WebKit's WebRTC switched off for the window; on the web and in the extension the nested-frame case must be measured again in Chromium before phase 1 ships.
4. On the web (and later in the extension), after the frame's **first `load`**, the parent sends **one `MessageChannel` port** to it, once. The broker answers only on that port, never with `postMessage(…, "*")`. If the frame navigates, the port dies with the old document.
5. The runner gets the verified entry: on the web (and later in the extension) over the port; on Desktop through `app_broker` (`start`), from the state Rust keeps for that window's label.
6. The runner sends **`writing`** on the port, then writes the entry into itself (`document.open`, `document.write`, `document.close`). The port, `window.ghostly` and the deleted constructors survive `document.open` (measured). From that moment **the runner is no longer a boundary**: the app runs in the same realm and can reach anything the runner left there. Every check belongs in the broker.
7. `document.close` fires a second `load` of the frame. **The parent accepts exactly one `load` after `writing`, and tears the app down on any other `load`**: it closes the port, removes the frame and shows "<app> stopped". A frame that loads at any other time has navigated. (Measured order: load 1, port ready, `writing`, load 2, app running.) On Desktop, `on_navigation` refuses every navigation instead.

**The broker** identifies an app by its port (web, and later the extension) or its window label (Desktop), never by origin, which is `"null"` for every sandboxed frame, and never by anything the app says. It answers only what the permissions allow. A **request** is at most 64 KiB, at most 50 a second per app; an answer can be larger (a file read through `ghostly.file`, up to the bundle's size).

**The broker's messages (phase 1), the whole `ghostly.*` API.** On the port each request is `{"id", "type", "args"}`, each answer `{"id", "ok": true, "value"}` or `{"id", "ok": false, "error"}`, each event `{"event", "data"}`; an unknown `type` is refused. On Desktop the same objects travel as the argument and result of `app_broker`, and events are emitted to that window only.

| `ghostly.*` | Message type | What it does |
|---|---|---|
| (runner only) | `start` (Desktop), `writing` | The entry; the start of the write |
| `ghostly.context()` | `context` | `{version, inChat, peer: {version} or null, name, theme, locale}` (`name` only with that permission; `theme` is `"light"` or `"dark"`, the client's; `locale` is the client's language as a BCP 47 tag, so the app can match both) |
| `ghostly.file(path)` | `file` | The bytes of a file of the bundle, as an `ArrayBuffer` |
| `ghostly.storage.get(key)`, `.set(key, value)`, `.delete(key)`, `.keys()` | `storage.get`, `storage.set`, `storage.delete`, `storage.keys` | The app's storage in the current scope (this app, this chat or alone): keys up to 256 bytes, JSON values up to 64 KiB, 5 MiB in all |
| `ghostly.chat.send(value)` | `chat.send` | One `paired-app` data frame (`chat` permission, live chat, the peer open). Refused with `offline` while the session is not live, with `too-large` when `value` passes 32 KiB as JSON, with `peer-closed` while the peer has not opened the app (or its client does not offer `apps/1`), and with `too-fast` past 48 a second for this app ([In a chat](#in-a-chat-apps1)) |
| `ghostly.chat.on("message" or "peer", f)` | events `chat.message`, `chat.peer` | A frame from the peer; the peer opened, closed or changed version, or the session went down or came back |
| `ghostly.close()` | `close` | Ends the app |

WebAssembly carried as a `data:` URL cannot be fetched (`connect-src 'none'` blocks `fetch` of `data:` too): the template decodes it in script, or reads it with `ghostly.file`, and compiles the bytes.

**The runner's CSP**, sent as an HTTP header where the client can, so the `sandbox` directive holds even if the page is opened directly:

```
sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval';
style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:;
connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none';
frame-ancestors 'self'
```

The runner's own script is inline, so `'unsafe-inline'` covers it and the app's inline scripts alike (a hash would turn `'unsafe-inline'` off). `'wasm-unsafe-eval'` lets games compile WebAssembly on every client. The runner's location must **not** carry the main page's policy: two policies intersect, and the main `script-src 'self'` would block the runner's inline code. It must still repeat the other headers every location sends (`X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Strict-Transport-Security`, `Permissions-Policy`).

### Per client

| Client | Phase 1 | Limits |
|---|---|---|
| **Web** (and the installed web app on phones) | An `<iframe sandbox="allow-scripts">` of `/app-frame.html` from the app's own server, in the chat or full screen. Its own nginx location, which does not include `nginx-headers.conf`, sends the runner CSP above with `frame-ancestors 'self'` (every other location keeps `frame-ancestors 'none'`). `/app-frame.html` is added to the service worker's `NEVER` list (`apps/web/src/sw/policy.ts`), so the page and its header always come from the server, never a cache. The main page's CSP gains an explicit `frame-src 'self'` | Same browser process as the app (no process isolation is assumed). **A self-hosted server that cannot send the header gets no apps:** the client fetches `/app-frame.html` once, and when the runner's header is missing it hides Apps (the owner's decision); the self-hosting notes name the header the location needs |
| **Extension** | **Later, not in phase 1** (the owner's decision, 2026-10-06). The design stays: a **sandbox page** (`sandbox.pages`) as the runner, framed in the chat, with the runner CSP as `content_security_policy.sandbox` (keeps `sandbox`, no `allow-same-origin`; loading measured). `extension_pages` gains `frame-src 'self'`, which closed the self-navigation leak in the review | Built after a test submission passes the Chrome Web Store review (a second purpose next to chat, the extension's existing `debugger` permission). Until then the extension shows no Apps |
| **Desktop** | **In phase 1** (the owner's decision, 2026-10-06). A **window of its own** per app instance, label `app-<random>`, on a new scheme `ghostly-app` (`ghostly-app://localhost/` on macOS and Linux, `http://ghostly-app.localhost/` on Windows) whose handler serves the runner with its CSP header (Tauri's configured CSP is not injected into custom-scheme responses). One command, **`app_broker`**, is allowed only for `app-*` labels, in a capability of its own. `only_main` (`apps/desktop/src/main.rs`) gains one exception, `app_broker` from an `app-*` window, and keeps refusing every other command there; its test covers both. The runner's `connect-src 'none'` blocks Tauri's `ipc:` fetch, so its calls take Tauri's `postMessage` fallback, which reaches the same check. Tauri treats the `ghostly-app` scheme as local for its capability check, and `app_broker` reaches Rust through the `postMessage` fallback (measured, Desktop spike). A problem the spike finds gets fixed; Desktop is not dropped from release 1.2. The app's identity comes from a label-to-state map kept in Rust, as `viewer.rs` does for shared apps, never from the message. `on_navigation` allows the runner once and refuses every other navigation, a reload and every nested frame (`about:srcdoc`, `about:blank`) included. On macOS the window also gets a WebKit configuration of its own: a content rule list that blocks every load but `ghostly-app:` (public API), and WebKit's `LinkPreconnect`, `LinkPreconnectEarlyHintsEnabled`, `DNSPrefetchingEnabled`, `LinkPrefetchEnabled` and `PeerConnectionEnabled` features off (private API; a WebKit missing one of them opens no app). Each of the two closes `<link rel=preconnect>`, which the CSP does not; the features also close WebRTC in nested frames. A per-window proxy was measured and does nothing in WKWebView. New windows are **denied without opening the system browser** (the shared-app viewer opens it; for an app that would be a way to send data out) | Not a frame in the main window: Tauri's bridge is in every frame, and on Linux Tauri cannot tell a frame's requests from its window's. WebKit honours the `sandbox` header from a custom scheme (measured on WKWebView); WebKitGTK on Linux is measured by the same spike, WebView2 on Windows before release |
| **CLI** | Publisher tools only ([Publishing](#publishing-the-publisher-cli)) | No apps run there |

### In a chat: `apps/1`

A mini-app with the `chat` permission can talk to the same app on the contact's side.

- `apps/1` is a session capability ([03](03-capabilities.md)) of the live chat session ([401](401-paired-chat.md)), listed in `paired-capabilities`. Its frame is **`paired-app`**, named like the session's other frames (`paired-message`, `paired-typing`). Three forms, all inside the session's encryption:
  - `{"t": "paired-app", "a": "<chat app id>", "o": "open", "v": "<version>"}` when the person opens the app in this chat, again on an update, and again when the live session comes back while the app is open;
  - `{"t": "paired-app", "a": "<chat app id>", "o": "close"}` when it ends;
  - `{"t": "paired-app", "a": "<chat app id>", "d": <JSON value>}`, data, taken only while both sides have sent `open` and neither `close`.
  - A frame has exactly one of `o` and `d`; one with both or neither is refused. `v` is required on `open`: a semantic version (as the manifest's `version`) of at most 64 characters, or the frame is refused. `a` is exactly 22 base64url characters. Other keys are ignored, so a later version can add some.
- `<chat app id>` = the first 16 bytes of HMAC-SHA-256(key, message), base64url without padding (22 characters), where key = SHA-256 of the UTF-8 bytes `ghostly-apps/1`, a zero byte, then the two sides' participation public keys (32 bytes each, raw), the lower one first by byte order; and message = the UTF-8 bytes of the app reference `<publisher key in z-base32>/<name>`. Both sides keep those pinned keys for the life of the chat, including chats started from a group, whereas the invite secret is not kept by every chat ([800](800-invite-join.md)). The key is not secret and need not be: the id only travels inside the encrypted session; it keeps one app's id different in each chat, so ids cannot be matched across a person's chats.
- **Size.** A data frame's `d`, as compact UTF-8 JSON, is at most **32 KiB**. `chat.send` refuses a larger value at the sender, so the app learns at once. The session's limit for any control frame, **60 KiB** (`LIMITS.maxControlFrameBytes` in `packages/core/src/frames.ts`), still holds above it and is not changed by this WISP: a frame over 60 KiB is dropped before it is read, as any other frame is. An app's frame therefore always fits, with room to spare for the frame's own fields.
- **The receiver enforces the limits**, since the sender's client may be the attacker: it drops a data frame whose `d` passes 32 KiB, frames beyond 50 a second per app (counted by `a` before the rest of the frame is read, malformed ones included; a frame without a valid `a` names no app and is dropped unread), data for an app not open on both sides, an `open` for a 17th app while the peer has 16 open on this session, and every `paired-app` frame unless both sides offer `apps/1`.
- **The sender keeps under it.** A client sends at most **48** data frames a second per app, so an `open` or a `close` always fits under the receiver's 50; past that `chat.send` fails with `too-fast`. `chat.send` names why a frame did not go: `not-open` (this side has not opened the app), `too-large`, `offline`, `peer-closed` (the peer has not opened it on this session, or does not offer `apps/1`) or `too-fast`.
- **Live only (phase 1).** `paired-app` frames go on the live session only: never on the DHT text floor ([403](403-dht-text.md)), never held ([404](404-store-and-forward.md)), never queued for later. While the session is not live, `chat.send` fails with `offline`, the app shows that it waits ("Chess needs you both online"), and the client keeps no copy of app frames to send later.
- **State per chat, and catch-up.** An app keeps its own state in its storage, which is per app and per chat ([Permissions](#permissions)), so a game survives a reload, a closed app or a lost session. When the session ends (or `apps/1` stops being agreed), each side's client tells each app the peer had open that it closed, marked `offline` (no frame travels; the session is gone), and its broker emits `chat.peer` with the peer closed. When it comes back and the app is open on a side, that side sends `open` again; once both have, each app gets `chat.peer` with the other's version and runs its own catch-up in data frames (Chess sends how many moves it has and the moves the other lacks). The client replays nothing: what to resend is the app's to decide.
- **Nothing is advertised.** A client never lists its installed apps to a contact. The reference crosses only when the person opens an app in a chat: the client sends an app card, "Ana opened Chess". **A contact who does not have the app** sees the card with "Install to play"; installing it opens the app in that chat. The card is an `app` card of [405](405-status-cards.md#an-app) with `opened` set.
- Two versions talk if the app says so: the broker hands each side the other's `version` from its `open` frame.
- Not on the DHT text path, not in groups in phase 1.

### A bot on the other side, and the agent console

The other side of `apps/1` can be a bot on the headless CLI ([1100](1100-headless.md)) instead of a person's app. The bot runs no app code: it speaks the app's messages.

- **Declaring.** The bot lists the app references it serves (`ghostly app serve <ref>`, kept in the profile's settings). Its daemon then offers `apps/1` and computes the chat app ids for those references only.
- **Receiving.** When the person opens the app in the chat with the bot, the daemon emits `app.opened {chat, app}`, then `app.message {chat, app, data}` for each frame, `data` being the app's JSON. For an agent ([AI-AGENTS.md](../AI-AGENTS.md)) it arrives as the contact's untrusted data, never as instructions.
- **Replying.** `ghostly app send --chat <chat> --app <ref> '<json>'`, or the same call on the daemon's socket.
- **Limits.** The daemon enforces the receiver's limits as an app does.
- **Granting.** The person installs the app and grants its permissions as for any app; the card says "Opens with <bot>".

**The agent console**, a surface for talking to AI agents and bots with their status, thinking indicators, buttons and task and routine cards ([405 status cards](405-status-cards.md), [406 message buttons](406-message-buttons.md)): **chosen as a built-in screen, not an app.** Its data is the chat itself (the cards, the messages, the Tasks board), and an app that reads a chat's content would need the broadest permission this design could grant to third-party code. The pieces it shows are already built in, and a built-in screen needs no store, no permission and no sandbox. It belongs to the Tasks board's work, not to this WISP. What this WISP adds for bots is the path above: a bot can ship **its own specialised app** (a dashboard for one agent, a form, a game master), and such an app may ask for a narrow `cards` permission (phase 2): read the task and routine cards that this contact sent in this chat, nothing else.

Phases: the bot side of `apps/1` (`serve`, the events, `app send`) and the `cards` permission are phase 2. Phase 1 has person-to-person apps only.

## Discovery without a central server

Three ways to an app, all equal and all checked the same way: **paste** a URL (in the Apps page or in a chat), browse a **store**, or install from a **card** someone sends in a chat.

### Publishing: the publisher CLI

A publisher needs four steps, about as many as Umbrel's template repository, two YAML files and a pull request:

1. `ghostly app init` makes a project from the SDK's template (single-file build, the broker's typings, the commit-reveal helper).
2. Build it with the template's command.
3. `ghostly app publish` makes the publisher key on first run (kept by the CLI, with a reminder to back it up), raises `sequence`, bundles, signs, writes the GitHub SSH proof into `proofs` (once publisher proofs exist, after phase 1), and writes **`app.ghostlyapp` at the repository root** (or on a `ghostly` branch). Committing the built bundle is required: a page cannot read GitHub release assets (no CORS).
4. Optional: `ghostly catalog submit <store repository>` writes the listing and opens the pull request to a store.

In release 1.2 the CLI has `ghostly app publish`, `ghostly app verify` (checks a bundle as a client would), `ghostly app revoke` (signs a `ghostly-revoke/1` statement with the app's publisher key and adds it to `ghostly-revoke.json` beside the bundle, [Revocation](#publisher-keys-no-rotation-in-phase-1)) and `ghostly store sign` (signs a store index with the store key). `ghostly app init`, the SDK's template with the commit-reveal helper, and `ghostly catalog submit` come later; until then a publisher builds the single-file app with its own tools and writes the listing by hand.

### Paste a URL

The person pastes `https://github.com/<owner>/<repo>` (or a `/tree/<ref>` form) in the Apps page, or in a chat as a message. The client reads, **without `api.github.com`**:

- `raw.githubusercontent.com/<owner>/<repo>/<ref or HEAD>/app.ghostlyapp`, an app, or
- `raw.githubusercontent.com/<owner>/<repo>/<ref or HEAD>/ghostly-store.json`, a store,

then shows the app's card or the store's summary, and installs or adds only when the person confirms. `HEAD` is fine because the signed digest, not the commit, pins the bytes: the client keeps the `sequence` it saw and treats what comes later by the update rule. Any other HTTPS URL that serves a bundle or a store index works the same way in the Apps page; Git hosts other than GitHub need nothing special beyond their raw file URLs.

### Stores

For people there is **one concept, "Stores"**: a list on the Apps page, the default one preloaded and removable, others added by paste or from a card. Each shows its name, its key's fingerprint, and whether it is curated or indexed.

**The store index, `ghostly-store.json`**, signed (`ghostly-store/1`):

```
{"ghostlyStore": 1, "key": "<store key>", "name", "description", "kind": "curated" | "indexed",
 "sequence", "expires",
 "apps": [{"ref", "sequence", "digest", "urls": [...], "title", "tagline", "category",
           "developer", "submitter", "repo", "support"}],
 "removed": [{"ref", "digest", "reason", "at"}],
 "revoked": [<publisher-signed ghostly-revoke/1 statements, verbatim>]}
```

- **Fields.** Times (`expires`, `at`) are Unix seconds. Required: `ghostlyStore` (1, else `unsupported-format`), `key`, `name` (one line, 1 to 40 characters), `kind`, `sequence` (1 to 2^53 - 1), `expires`, `apps`, `removed`, `revoked`; `description` (2000 characters, line feeds allowed) is optional. An `apps` entry requires `ref`, `sequence`, `digest`, `urls` (1 to 4), `title` (40) and `tagline` (80), and may have `category`, `developer` and `submitter` (one line of 40 characters each) and `repo` and `support` (URLs); one app is listed at most once (`duplicate-app`). A `removed` entry is exactly `{ref, digest, reason, at}`, the reason one line of 1 to 200 characters. `apps`, `removed` and `revoked` hold at most 4096 entries each, and the index at most 16 MiB before compression. Any other key is refused (`unknown-key`), a missing one too (`missing-key`), a field out of bounds is `bad-field`, and a `revoked` entry that does not verify refuses the whole index (`bad-revocation`): the store copied it, so a broken one is the store's fault.
- **Reading, in this order:** size (`too-large`), JSON (`not-json`), canonical bytes (`not-canonical`), the fields and revocations as above, the signature statement (`bad-signature-statement`), the store key the reader holds (`store-key`), the signature (`signature-key`, `bad-signature`), then `expires` (`expires-too-far`).
- **Signature:** `ghostly-store.sig` beside it, the same statement as a bundle's (`{"alg": "ed25519", "key", "sig"}`, prefix `ghostly-store/1`). The index's bytes must be its canonical form, as a manifest's. Keys are z-base32, hashes and signatures base64url.
- `urls` point at the bundle: the publisher's raw URL, and a jsDelivr URL pinned to the commit the curator reviewed (immutable, and kept after a repository is deleted). **A jsDelivr URL MUST name a full 40-character commit**, as `https://cdn.jsdelivr.net/gh/<owner>/<repo>@<commit>/app.ghostlyapp`; one naming a branch, a tag, a version range or `latest` is refused wherever it appears (an index, a card, the Apps page), since jsDelivr serves those from a copy that moves.
- The listing fields are Umbrel's (`tagline`, `category`, `developer`, `submitter`, `repo`, `support`). The icon, the screenshots and the description come **from the bundle**, which the publisher signed, never from the store, so a store cannot dress an app in someone else's pictures.
- `expires` is at most 90 days ahead of the reader's clock (`expires-too-far`); past it the store still installs, and the Apps page says "<store> was not updated since <date>". A lower `sequence` than the one held is refused (`rollback`), and the same `sequence` with other bytes (another SHA-256 of the index) is refused as equivocation, the held index kept, as for apps. A store is its key: an index under another key than the one the person added is another store (`store-key`).
- A store's repository is a folder per app, as Umbrel's: `apps/<name>.<publisher prefix>/listing.json`, where `listing.json` is exactly one entry of `apps` above (the same keys, nothing else), written by `ghostly catalog submit`. The signed `ghostly-store.json` is built from those files. The client reads only `ghostly-store.json`.

**Ghostly's default store** is one repository of its own, separate from Ghostly's repository, so its pull requests and takedowns stay apart from the app's (the owner's decision, 2026-10-06), curated by the maintainers. Apps enter by **pull request**; CI checks each submission (the bundle at `urls` has the listed digest and verifies, the bounds hold, the listing is well formed); **the owner signs `ghostly-store.json` with the store key, held offline**, in batches. A key held by CI would make a GitHub account takeover a store takeover.

**First-party mini-apps** (Chess, in `apps/mini/chess` of Ghostly's repository) are signed by a **publisher key of their own, distinct from the store key**. The store key lists apps and never signs a package, so a stolen store key cannot sign an app update, and a stolen publisher key cannot sign a store index. A first-party app enters the default store by the same pull request as anyone's.

**The default index** (release 1.3, with its crawler; phase 1 has the default store, stores added by URL and apps added by URL or card) is a second signed file in the same repository, `index/ghostly-store.json` with `"kind": "indexed"`, built by a crawler script. The crawler's input is `index/sources.json` in that repository: a list of store URLs and app repository URLs, extended by pull request (no crawling of GitHub search in phase 1). **The owner's offline key signs both files for now** (the owner's decision); a separate index key, itself signed by the owner's key, only if signing by hand becomes the bottleneck. The client reads both directly; no service runs. Both are preloaded; either can be removed.

**A custom store or index** is any HTTPS URL serving a signed store index: a Git repository, GitHub Pages, any static host. The crawler is in this repository (planned, `infra/services/indexer`), runnable by anyone as a script or a Docker image (an Umbrel package is a candidate). An indexer service with search, reviews and reports is phase 2 and optional.

**Several stores at once.** Results are merged by app reference, and each shows "in <store>" for a curated store or "Found by <index>" for an indexed one. When stores disagree (versions, removals), the page shows both. A store lists and ranks; it cannot change what installs.

**Privacy.** The client downloads whole store indexes and searches locally; a store host sees the address and time of each index download, not what the person looks for. An index above 4 MiB compressed is refused in phase 1.

**Paid ranking**, for later: an entry may be marked `promoted`, shown "Promoted by <store>"; the merged list sorts by the client's own relevance, never by one store's order across others.

**Umbrel and Ghostly, side by side:**

| | Umbrel | Ghostly (this draft) |
|---|---|---|
| What is installed | Docker containers on a server the person owns | One signed HTML app in a sandbox on each device; no server |
| Where the code lives | In the store repository | In the publisher's repository, as one committed bundle; the store points to it |
| How it is fetched | `git clone` on the server | One HTTPS read of the bundle (raw GitHub or jsDelivr, both CORS-readable) |
| Signatures | None | Publisher signature on every package, store key on every index |
| Pinning | The default branch's tip, polled every 5 minutes | `sequence` and digest per app; the jsDelivr URL pinned to a commit |
| Adding | A store by Git URL | A store or a single app by URL, or an app from a chat |
| Default store | Cannot be removed | Preloaded, removable |

**If GitHub takes a repository down, or is blocked:** installed apps keep working (the client runs its stored copy, nothing phones home); updates come from any other `urls` or `sources` entry; new installs come from jsDelivr's commit-pinned copy, any other host, or a bundle a contact sends. The digest makes every source equal, and a chat needs no web host at all.

### Apps sent in a chat

A chat is a source like any other, so installing never depends on one store.

**Two forms, one file:**

- **A pointer card.** The person shares an app (Apps page, "Share", or a pasted URL that holds an app). The sender's client attaches an `app` card in the message's `sc` field, as [405 status cards](405-status-cards.md#an-app) defines it: `{"kind": "app", "id", "ref", "digest", "sequence", "title", "version", "url", "opened"}`, `opened` only for the "Ana opened Chess" card. The message's text is the card's fallback, with the URL on a line of its own, so an older app shows a link.
- **The bundle as a file** (after phase 1), with `files/3` ([501](501-paired-files.md)). The receiver's client recognizes the bundle by its first bytes and shows the same card on the file bubble. The files' consent rules hold: arriving is not installing.

**The card is shown from its own data, and nothing is fetched to show it.** A pointer card's fields are the sender's, unsigned, so the card says so: title and version from the card, a generic icon, the publisher fingerprint from `ref`, and "Not checked yet". **The client fetches the bundle only when the person presses Install**, then checks it and shows the real install screen (icon, proof, permissions) before anything is stored. In phase 1 a card's `url` must be on `raw.githubusercontent.com` or on `cdn.jsdelivr.net` pinned to a commit ([Stores](#stores)); any other host is refused on a card (it still works pasted in the Apps page, where the person chose it). Later, a card may name another host, and the client then names that host and waits for the person before any request (the owner's decision). A bundle sent as a file is checked as soon as it arrives, since it is already on the device, and its card shows the checked data.

**After the check, the card and the install screen say:** "github.com/ana ✓" or "Unknown publisher", the fingerprint, "Sent by <contact>", the permissions, the IP line, and one of "In <store>" (a curated store), "Not in any of your stores" (installable: the owner's decision; shown also when only an index lists it, with "Found by <index>") or "Removed by <store>: <reason>" (not installable).

**When the card names a `sequence`** and the bundle fetched has a higher one of the same app, that is fine: it is newer. A lower one is refused.

**The sender is not the publisher.** A card or a bundle is carried, not vouched for, and says "Sent by Ana", never "Ana's app". A forwarder cannot change a byte without breaking the signature.

**Updates** of an app received in a chat come from its `sources` and the person's stores, never from the sender. A newer valid version that arrives later in any chat is taken as an update.

**What keeps a chat from becoming a malware channel:** unsigned or broken bundles are refused ("Not signed. Ghostly won't install it."), with no "install anyway" (developers sign test builds with a throwaway key); nothing installs or runs from a card by itself; the same sandbox and broker; removals and revocations checked before Install is enabled; at most 3 cards per message.

**Stores are shareable the same way, later:** a store's URL in a message will get a store card ("Store · <name> · 24 apps", "Add store"), shown from the sender's data and read only when the person presses Add. Its `store` kind is not defined in [405](405-status-cards.md) yet; until it is, a store's URL travels as a link, and the person adds the store by pasting it in the Apps page.

This is what makes **the default store one source among many**: apps and stores spread from person to person, and the client gives the default no power the others lack.

### Takedowns and malware reports, with no authority

- **A store** removes an app with a `removed` entry and a reason.
- **A publisher** revokes its own versions.
- **The client** checks the stores the person added at every update check. When one marks an installed digest as removed for malware, the app is **stopped** and the person decides: "Remove", "Keep it stopped", or, behind "Details", "Run anyway". A publisher's revocation stops it with no "Run anyway".
- **Reports** (phase 2) are signed (`ghostly-report/1`) statements sent to an indexer service; the client never sends one the person did not write.

A store the person did not add has no effect on their device.

## Paying (phase 2)

The owner chose free apps only for now. This section keeps the design so the format leaves room for it.

**Rails.** Chat payments ([200](200-payments.md)): Cashu first (every client, a test mint, the faucet button), then Lightning cards. Testnet first; every Mainnet purchase passes the `confirmedReal` gate.

**A purchase.** `price` is `{"amount", "unit": "sat", "seller": "<HTTPS URL>"}`. The seller is a **sales bot**, the publisher's headless CLI ([1100](1100-headless.md)). A `ghostly1` code pairs exactly one chat ([800](800-invite-join.md#baseline-and-purpose)), so the `seller` URL answers each request with a fresh invite the bot made. "Buy" opens that chat; the bot sends a `pay-req`, the person pays in the sheet they know, and the bot answers with a licence and message buttons ([406](406-message-buttons.md)) for support or refunds.

**The licence.** `{"ghostlyLicence": 1, "app", "holder", "versions", "issued", "payment"}`, signed `ghostly-licence/1`. The holder key is HKDF-SHA-256 with the DID seed as input, salt `ghostly-licence/1` and the publisher key as info: per profile (it follows backups and [06](06-devices.md) handoffs; a licence per device would break at every handoff) and per publisher (publishers cannot link one buyer's purchases). Limits, said plainly: a device removed under [06](06-devices.md) keeps the DID seed and so every licence key; and a review that showed "Bought it" would expose a holder key, so reviews never show it.

**What a licence gates:** the honest client installs and updates a paid app only with a valid licence, checked offline. The files of a public bundle can still be copied. No DRM. Refunds are the publisher's policy, paid back in the same chat. Key loss: the licence is lost with the profile when there is no backup.

**Every derivation from the DID seed,** kept in one list so labels never collide:

| Key | Derivation | Where |
|---|---|---|
| DID key | The seed itself, as an Ed25519 seed | [310 did:dht](310-did-dht.md), `packages/browser/src/engine/did.ts` |
| First device-set secret `D0` | HKDF-SHA-256, salt `ghostly-devices/1`, info `device-set` | [06](06-devices.md#terms) |
| Licence holder key | HKDF-SHA-256, salt `ghostly-licence/1`, info = publisher key | This WISP, phase 2 |
| Reviewer key | HKDF-SHA-256, salt `ghostly-review/1`, info `reviewer` | This WISP, phase 2 |

A new derivation adds a row here, or to the WISP that owns it with a link here.

## Reputation (phase 2)

- **A review** is `{"ghostlyReview": 1, "app", "digest", "rating": 1-5, "text" (2000 characters), "at", "reviewer"}`, signed `ghostly-review/1` by the reviewer key: one pseudonym per profile, the same across the person's reviews.
- Indexer services collect reviews; a person can share one in a chat as a card.
- **The client shows** reviews from the person's contacts first (a review card received in a chat is that contact's), then each indexer's, labelled, with counts per indexer, never added into one number.
- **Sybil resistance:** no global score, no follower counts, no weight for payment, and no "Bought it" mark (it would link licence keys across publishers).
- **Conflicts are shown:** "In <store> · removed by <other store>".

## Security and privacy

### Threats

| Threat | What limits it | What remains |
|---|---|---|
| A malicious app sends data out | Opaque origin, `connect-src 'none'`, WebRTC constructors deleted, `frame-src 'self'` on the parent, the port dying on navigation and teardown on any load but the one after `writing`, no Desktop command but `app_broker`, navigation and new windows blocked on Desktop | Channels not measured yet (DNS prefetch on the web, WebKitGTK, WebView2); a browser or webview sandbox escape. Hence the IP line on every install screen |
| A malicious app abuses the broker | Identity from the port or window label, per-app and per-chat storage, bounded sizes and rates, permissions | Misuse within granted permissions; phishing inside its own frame (the client frames apps in a visibly different container and never asks for secrets there) |
| A malicious update | Same key, rising `sequence`, new permissions re-asked, removals and revocations checked | Misbehaviour within permissions already granted |
| A compromised publisher key | Revocation by the publisher if it still can; stores remove the app | No rotation in phase 1: holders trust the attacker's next version until a store they added removes it |
| A malicious or lying store | It cannot change bytes; icons and descriptions come from bundles; every result names its store | Hiding apps, steering a title search to a look-alike app. The proof line and the 80-bit fingerprint are the defence |
| A store that censors | Other stores, a pasted URL, a card in a chat | Discovery is harder |
| GitHub removes or blocks a repository | Stored copies, jsDelivr by commit, other hosts, chat bundles | New installs need someone with the bytes |
| A chat card as bait or as a tracker | Shown from its own data, fetched only on Install, phase 1 hosts allowlisted, "Unknown publisher", unsigned refused | A person who installs a signed harmful app from a stranger |
| A contact's client floods `apps/1` | The receiver's own limits | None beyond the chat |
| Rollback, freeze, equivocation | `sequence` per app, store `sequence` and `expires`; on equivocation the client keeps what it runs and refuses the other | A frozen publisher repository until phase 2 |
| Parser disagreement | Canonical manifest bytes required, trailing bytes refused | None known |
| A bug in the runner or the broker | Small trusted code, tests for every message type, bounded sizes | It is the boundary; it gets security review |

### What each party learns

| Party | Learns |
|---|---|
| GitHub, jsDelivr, any source | The address that fetched a bundle, when. Nothing before the person presses Install (cards fetch nothing) |
| A store host | The address and time of each index download: only for people with an app installed, or who open a store |
| A publisher | Possibly the person's address and when they open the app, through channels not yet measured |
| A contact | Only the apps the person opens in a chat with them, or shares |
| `api.github.com` | The publisher login whose proof is checked, from the person's address, at install, once publisher proofs exist (after phase 1). In phase 1 the client never asks it |
| Ghostly's maintainers | What the default store's host (GitHub) would tell them: nothing, as they run no server |

### Before phase 1 ships: the tests that must exist

- Bundles that break each bound, a non-canonical manifest, a duplicated key, a bad signature, a wrong file hash, a truncated bundle, a byte past the last file: refused, nothing stored.
- A lower `sequence`, an equal one with another digest: refused and marked.
- The malicious mini-app suite, on each client: fetch and every resource type, WebRTC (including through a nested frame), self-navigation by `location`, meta refresh and link, a load before `writing` or a third load (each tears down; the one load after `writing` does not), popups, `top.location`, reading storage, posting to `"*"` and to other windows, calling any Desktop command but `app_broker`, `app_broker` with another app's identity, opening a new window, extension APIs, flooding the broker, oversized messages. Every one fails.
- `contentSecurityPolicy.test.ts` checks `frame-src 'self'` on the web page (and on the extension pages once the extension runs apps), the runner's header with `frame-ancestors 'self'`, and that every other web location keeps `frame-ancestors 'none'`.
- The runner refuses to start with a non-null origin, without a parent, or under a label that is not `app-*`.
- The service worker never answers `/app-frame.html` (`policy.ts` test); the runner's location repeats the common headers; `only_main`'s test allows `app_broker` from an `app-*` window and refuses every other command there.
- An app sent as a crawled listing only (an indexed store) keeps "Unknown publisher" and "Not in any of your stores".
- A card renders with no network request; Install fetches only from the allowlisted hosts.
- A receiver drops a `paired-app` data frame whose `d` passes 32 KiB, frames beyond 50 a second, data for an app not open on both sides, and every `paired-app` frame without `apps/1` on both sides; a frame over 60 KiB is dropped before it is read. `chat.send` refuses a value over 32 KiB and, while the session is not live, fails with `offline`; nothing goes on the DHT or into a hold.
- With no app installed, the client makes no request to any store.
- An e2e: Ana installs Chess from a store and opens it in her chat with Bob; Bob sees the card, no request goes out until he presses Install, then they play over `apps/1`; Bob reloads, and the game comes back from his per-chat storage and the catch-up after the session returns. On web with web, and web with Desktop.
- The vectors of [Test vectors](#test-vectors), read by every parser of these formats.

## Compatibility and rollout

All additive. An older app sees an app card as its text (a link: [405](405-status-cards.md#an-app)), a bundle as a file, and never offers `apps/1`, so no `paired-app` frame is sent to it; one that arrived anyway is an unknown frame, which it drops. The 60 KiB control-frame limit does not change. Nothing changes in records, invites, groups or payments. The web server gets one location with its own header and the main page an explicit `frame-src 'self'`; Desktop gets one scheme, one capability and one command; the extension's manifest gets a sandbox page and `frame-src 'self'` when the extension runs apps, after phase 1.

## Phases

### Phase 1 (release 1.2): the smallest useful store

**Free mini-apps, turn-based games and light real-time versus games (Tetris, Snake) included, played live in a 1:1 chat, on the web app and Desktop, installed from a pasted URL, a store or a card in a chat. No network access for apps. The default store is a signed file in a repository of its own, signed with the owner's offline key; custom stores are HTTPS URLs. Behind a feature flag on `dev` until the web chess e2e passes.** In pieces that can each be a pull request:

1. **Format and publisher tools.** Bundle, canonical manifest, digest, signatures with their prefixes, revocation, with the [test vectors](#test-vectors), in `packages/core`. `ghostly app publish`, `ghostly app verify`, `ghostly app revoke` and `ghostly store sign` in the CLI.
2. **The package store.** Verified bundles kept per profile, with `sequence`, permissions and per-app, per-chat storage. Install, update, uninstall with export.
3. **The runner and the broker.** `/app-frame.html` and its nginx location on web; the `ghostly-app` scheme, `app-*` windows and `app_broker` on Desktop, after a Desktop spike that measures them. The port, the teardown, the WebRTC deletion, `frame-src 'self'`. The malicious mini-app suite.
4. **The Apps page.** Installed apps, paste, Stores, permissions with the IP line, updates, the removal screen.
5. **Stores.** `ghostly-store.json`, its signature, `sequence`, `expires` and `removed`; reading from raw GitHub and jsDelivr; merging several.
6. **In a chat.** The app card from its own data, Install fetching only then; `apps/1` and its `paired-app` frame with receiver limits, live only, and the "opened Chess" card.
7. **Ghostly's default store.** The repository of its own, its pull request checks in CI, the owner's offline signing; Chess listed, signed by its own publisher key.

Phase 1 has no payments, no reviews, no themes, no network permission, no fast real-time games (the unordered mode), no play while one side is offline, no bots on `apps/1`, no groups, no key rotation, no adapter plugins, no apps in the extension, no bundle sent as a file, no store card, and no crawler or default index.

### Later phases and research

| Phase | What it gives |
|---|---|
| 1.2.x, 1.3 | `ghostly app init`, the SDK's single-file template with the commit-reveal helper, and `ghostly catalog submit`. Apps in the extension, after a test submission passes the Chrome Web Store review. A bundle sent as a file over `files/3`. The `store` card. The crawler and the default index (1.3) |
| 2 | Real-time games: the `realtime` permission, the unordered mode on `apps/1` over WebRTC, 64 MiB bundles. Bots on the other side of `apps/1` (`ghostly app serve`, `app.message` events, `ghostly app send`) and the `cards` permission. Themes as typed values. Paid apps on Testnet, then Mainnet when the owner says. Licences, reviews and reports, and an optional indexer service with search. Key rotation with a pinned recovery key. The publisher's Pkarr record. The `network` permission as an exact list of sites. Apps in groups |
| 3 | Bots for the CLI as signed packages under an operating-system sandbox. A frame in the chat on Desktop once tested. Package sources over peer-to-peer content addressing |
| Research | A permissioned host for adapter plugins (WebAssembly components get only the capabilities the host gives them, [component model](https://component-model.bytecodealliance.org/)); process isolation for apps; a transparency log for publisher keys; reproducible-build checks by stores |

If an iOS client appears, paid apps would meet Apple's in-app purchase rule; that is a phase 2 question, not a phase 1 one.

## Decisions and open questions

**Decided:** the six answers in [Decisions taken by the owner](#decisions-taken-by-the-owner-2026-10-03); the new family 1200-1299, with this contract as 1200 (accepted on 2026-10-06); the answers in [Decisions taken by the owner (2026-10-06)](#decisions-taken-by-the-owner-2026-10-06); mini-apps first, themes deferred; the agent console as a built-in screen, with bots able to serve their own apps over `apps/1` in phase 2; adapter plugins out of the store until a plugin host; one bundle as the published unit; a single self-contained HTML entry; no rotation in phase 1; one "Stores" concept; cards shown from their own data; storage per app and per chat; licences per profile, derived per publisher, in phase 2.

**Decided for the owner by the coordinator (2026-10-03):** a self-hosted web server that cannot send the runner's header gets no apps, and the client hides Apps there, documented in the self-hosting notes; phase 1 chat cards fetch only from `raw.githubusercontent.com` and jsDelivr, other hosts later with a warning naming the host before any request; the owner's offline key signs both the default store and the default index, with a separate index key (signed by the owner's key) only if signing by hand becomes the bottleneck.

**No question is open for the owner.** What is left belongs to the builders, each decided above or by the phase 1 piece named:

| Builder decision | Where it is settled |
|---|---|
| The broker's message types and the `ghostly.*` API | [The runner and the broker](#the-runner-and-the-broker); a new type needs a change to this WISP |
| The store index signature | [Stores](#stores): `ghostly-store.sig`, prefix `ghostly-store/1`, canonical bytes |
| Where revocations are published and read | [Publisher keys](#publisher-keys-no-rotation-in-phase-1): `ghostly-revoke.json` beside the bundle, copied into store indexes |
| How the entry reaches the runner on Desktop | `app_broker` `start`, from the state Rust keeps for the window's label |
| `apps/1` open, close and version frames, the `paired-app` name and its 32 KiB data cap | [In a chat](#in-a-chat-apps1) |
| `listing.json` and the crawler's input | [Stores](#stores): one index entry per file; `index/sources.json` |
| Storage backend, export, backups, device handoff | [Where installed apps live](#updates-and-rollback) |
| HMAC input bytes; z-base32 or base64url | [In a chat](#in-a-chat-apps1); keys and fingerprints are z-base32, hashes, signatures and chat app ids base64url without padding, Git commits hex |
| Test vectors for every byte format above, and their files | [Test vectors](#test-vectors); phase 1 piece 1, before any client code reads a bundle |
| Whether Tauri treats `ghostly-app` as local, and WebKit's `sandbox` header from a custom scheme | The Desktop spike, before phase 1 piece 3 lands on Desktop. A problem it finds gets fixed: Desktop is in release 1.2 (the owner's decision, 2026-10-06) |

## Test vectors

Every byte format of this WISP is pinned by vectors before any client reads a bundle (phase 1 piece 1), and before this draft can be Proposed ([00](00-process.md#process)). They follow the layout of the device vectors ([06](06-devices.md)):

- **Where.** One JSON file per format in `packages/core/test/vectors/`, checked in.
- **How they are made.** Each file is built by its test from fixed labels: every key and seed is the SHA-256 of `ghostly apps vectors: <label>`, a test value and never a real key. The test writes the file again when an environment variable says so (`APPS_VECTORS_WRITE=1`), and otherwise reads it and fails on any difference, so a change to a format shows in review as a changed vector.
- **Shape.** Each file has `about` (what it pins, the section of this WISP and the test that builds it), the fixed inputs, `valid` (cases a reader must accept, each with what it must read) and `invalid` (cases a reader must refuse: `name`, `refusal`, the reader's reason, and the bytes or the JSON).
- **Encodings.** Raw bytes are hex in the files; keys are z-base32, and hashes, signatures and chat app ids base64url without padding, as on the wire. A bundle's bytes are a list of segments to join in order, `{"hex": "..."}` as written or `{"fill": "<one byte in hex>", "size": <n>}` for that byte repeated, so the 16 MiB case stays a few lines; each valid bundle also gives its length and SHA-256. JSON that must be read as exact bytes (a store index, a statement) is given as its exact text.
- **The reader's clock** is fixed at `now` = 1790000000 (Unix seconds) in every file.
- **Refusals** are the codes of [Reading a bundle](#signatures-one-rule-for-every-statement) and [Stores](#stores). Two parsers that refuse one case with different codes have a bug, though only the refusal itself is the security property.
- **Who reads them.** Every parser of these formats: the TypeScript one in `packages/core` in phase 1, and any other later (Rust on Desktop, another client). Two parsers that read one vector differently means a bug in one of them.

| File | Pins | Valid cases | Refusals, at least |
|---|---|---|---|
| `app-bundle.json` | [The bundle](#the-bundle-the-one-published-unit), the canonical manifest, the digest and the `ghostly-app/1` signature | A bundle with the entry only; one with an icon, screenshots and data files; each bound at its limit (but the manifest's 64 KiB, which a manifest within the field bounds cannot reach: it is pinned by its refusal only) | Each bound passed by one; a manifest that is not canonical; a duplicated key; an unknown key; `price` or `recovery`; a bad signature; a signature by another key; a wrong file size or hash; a path with `..`, an empty segment, or two paths equal ignoring case; a wrong magic; a truncated bundle; a byte past the last file |
| `app-statements.json` | `ghostly-revoke/1` (by digests, and up to a `sequence`), and one object signed under each phase 1 prefix of [Signatures](#signatures-one-rule-for-every-statement) (`ghostly-app/1`, `ghostly-store/1`, `ghostly-revoke/1`; `ghostly-publisher/1` comes with publisher proofs, later) | Each statement, with its signed bytes; signed revocations; a `ghostly-revoke.json` | A statement checked under another prefix or another key; one that is not canonical; each malformed revocation |
| `app-store.json` | `ghostly-store.json` with `ghostly-store.sig` ([Stores](#stores)), a `listing.json` entry, and the update rule as decisions for indexes (`new`, `update`, `same`, `rollback`, `equivocation`, `other-key`) and apps (`update`, `same`, `rollback`, `equivocation`, `other-app`) | An index with apps, `removed` and `revoked`; each kind; `expires` exactly 90 days ahead, and past | Bytes that are not canonical; a bad signature; `expires` more than 90 days ahead; a jsDelivr URL with a branch, a tag, a range, a short commit or `latest`; an unknown key; the reader's refusal of a lower `sequence` than one it holds |
| `app-chat.json` | The chat app id and the `paired-app` frames ([In a chat](#in-a-chat-apps1)) | Ids for one pair of keys given in both orders (the same id) and for two apps; an `open`, a `close`, and data frames whose `d` is small and exactly 32 KiB | `d` one byte past 32 KiB; an unknown `o`; no `a`; an `a` that is not 22 characters |
| `app-card.json` | The `app` card ([405](405-status-cards.md#an-app)) and its fallback text | A shared card and an opened card, with and without `url` | Each required field missing or invalid; a `ref` whose key is not 52 z-base32 characters; an `id` that does not match the `ref`; a `url` that is not https |

## Conformance (candidate)

A client that implements this WISP MUST:

- install, update or run a bundle only when its manifest is canonical and holds every bound, its signature verifies under the publisher key, every file matches its size and hash, and no byte follows the last file;
- identify an app by publisher key and name, never by a store or a URL;
- never install a lower `sequence` over a higher one, and on two packages of one app with the same `sequence` and different digests keep the one it runs and refuse the other;
- look for updates only in `sources` and the person's stores, and only while an app is installed; take a valid newer version from anywhere;
- show the permissions and the IP line before installing, re-ask when an update adds a permission, and grant none on behalf of a store or a contact;
- run a mini-app only in a runner that checked its origin or label, deleted the WebRTC constructors and sent the CSP above; answer it only through the broker, on its own port or window label, within its permissions and bounds; accept exactly one frame `load` after the runner's `writing` and tear the app down on any other; keep its storage per app and per chat;
- on Desktop, allow an app window no command but `app_broker`, take its identity from its label, block its navigation and deny new windows without opening the system browser;
- enforce the `paired-app` limits as a receiver (32 KiB of data, 50 frames a second per app, both sides open, `apps/1` on both sides), and send `paired-app` frames on the live session only;
- show a chat card from its own data, fetch nothing until Install, and in phase 1 fetch only from the allowlisted hosts, a jsDelivr URL only when it names a commit;
- show "Unknown publisher" when no proof verifies and no curated store of the person's lists the app, and never let an indexed store clear that warning or "Not in any of your stores"; show at least 80 bits of the publisher key;
- never install or run anything from a card or a bundle by itself, and refuse unsigned packages;
- never advertise installed apps to contacts;
- check the removals and revocations of the person's stores before an install and at every update check, and stop an app its publisher revoked;
- refuse a store index with a lower `sequence` than the one held, and say when one is past `expires`.

## References

[SDK](../SDK.md), [browser boundaries](../BROWSER.md), [roadmap](ADAPTER-ROADMAP.md#plugins-apps-catalogs-and-ghostlyos), [local services](700-local-services.md), [HTTP services](701-http-services.md), [chat session](401-paired-chat.md), [chat files](501-paired-files.md), [status cards](405-status-cards.md), [message buttons](406-message-buttons.md), [payments](200-payments.md), [identity proofs](300-peer-proofs.md), [SSH proofs](307-ssh.md), [invites](800-invite-join.md), [devices](06-devices.md), [headless](1100-headless.md). Outside sources are in [What the outside world allows](#what-the-outside-world-allows-sources); also [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) (JSON canonicalization) and [RFC 5869](https://www.rfc-editor.org/rfc/rfc5869) (HKDF).

## Revision log

One file per change in [changes/1200-marketplace/](changes/1200-marketplace/) ([how](00-process.md#revisions)). The site lists them here, newest first, and derives the Revision and Updated rows from them.
