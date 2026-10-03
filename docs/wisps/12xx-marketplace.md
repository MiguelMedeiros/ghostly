# WISP 12xx: Apps and Plugins: Packages, Catalogs and Indexers

| Field | Value |
|---|---|
| Candidate number | 12xx; a new family (1200-1299), number to be defined; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [02](02-peer-keys.md), [03](03-capabilities.md), [04](04-profiles.md), [05](05-backups.md), [06](06-devices.md), [200](200-payments.md), [205](205-lnurl.md), [300](300-peer-proofs.md), [3xx did:dht](3xx-did-dht.md), [400](400-chat.md), [401](401-paired-chat.md), [4xx status cards](4xx-status-cards.md), [4xx message buttons](4xx-message-buttons.md), [500](500-files.md), [501](501-paired-files.md), [700](700-local-services.md), [701](701-http-services.md), [11xx](11xx-headless.md) |
| Implementation | None. A proposal: nothing of it is on `dev` or in a release. Code starts after release 1.1 |
| Summary | Install apps made by others: from catalogs you add by pasting a Git URL, or sent to you in a chat. Each is checked against its publisher's signature and runs in a sandbox. |
| Availability | Planned |
| Notes | Not in the app. Phase 1 proposes free mini-apps and themes on the web app, the extension and Desktop. Paid apps come later, on test coins first. |

> This is a review draft. Candidate numbers and new record formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md) and [implementation evidence](IMPLEMENTATION.md).

Number note: no family fits a store. The closest, [700](700-local-services.md) (local services), is about a contact opening an app that runs on your computer, not about installing code. The [roadmap](ADAPTER-ROADMAP.md) already treats "Apps and catalogs" (track 08) as a line of its own, so this draft proposes a new family, 1200-1299, "Apps and plugins". A family's contract takes its x00 number (100, 200, 1000), so this one would be 1200; it stays `12xx`, number unassigned, until the owner accepts the family ([NUMBERING](NUMBERING.md), [00](00-process.md#process)). If the owner prefers to keep it inside an existing family, 7xx is the alternative, and only the number changes.

## Purpose

The owner wants a marketplace, and chose its first goods: **apps and plugins for Ghostly**. Not services, not physical goods. This document is the design, written before the code, which starts after release 1.1.

It answers, in order:

1. what an app and a plugin are in Ghostly, and which kinds phase 1 carries;
2. the package: manifest, signatures, content addresses, updates, permissions;
3. where an app runs on each client, and its sandbox;
4. how apps are found without a central server: **catalogs** (Git repositories, as Umbrel does it), **apps sent in a chat**, and **indexers** the person chooses;
5. paying, without an account;
6. reviews and trust;
7. the threats;
8. the phases;
9. the questions left for the owner.

The point of the design is that **no single source is required**. The default catalog and the default indexer are run by Ghostly's maintainers, and they are one source among many: a pasted Git URL, someone else's catalog and an app a friend sends in a chat install the same way, with the same checks.

## Goals and non-goals

In scope:

- Free mini-apps (games, polls, shared tools) and themes, installed from a Git URL, a catalog or a chat, in phase 1.
- A package format, signatures and updates that do not trust the host the bytes came from (GitHub, a mirror, a contact).
- Catalogs and indexers anyone can run, several at once, chosen by the person.
- A design for paid apps, licences, reviews and takedowns that needs no Ghostly server and no account.

Out of scope, on purpose:

- **Adapter plugins from a store.** A wallet source or an identity proof runs inside the engine with every key ([SDK.md](../SDK.md#trust-model-first)). Nothing that runs there is installed from a store until a permissioned plugin host exists (research, [Phases](#later-phases-and-research)).
- **DRM.** A package published in a public Git repository can be copied. A licence gates what an honest client does, not what a determined person does ([Paying](#paying)).
- **Services and physical goods.** The roadmap's "Marketplaces / hosting example" row stays a later product question.
- **A Ghostly account or a central store server.** There is none today, and this design adds none.

## What exists today (evidence)

Each fact was checked against the file it names on `dev` on 2026-10-02. Where one is wrong, the section that cites it must change.

| Fact | Where |
|---|---|
| The SDK exists in the repository, not on npm. A plugin is a plain object naming adapters of three kinds: Lightning sources, on-chain sources and identity proofs. Transports have no registration | `packages/sdk`, `packages/browser/src/plugins/registry.ts` (`GhostlyAdapterPlugin`, `SDK_API = 1`), [SDK.md](../SDK.md#transports-and-a-minimal-client) |
| An adapter runs with the app's privileges: it can read every key, sign anything, spend everything and reach any network the page can. No sandbox, no permission prompt, no signature check, no store | [SDK.md](../SDK.md#trust-model-first), `packages/browser/src/plugins/registry.ts` |
| Plugins enter only at build time (`GHOSTLY_PLUGINS`, read by the Vite plugin) or from code already in the engine's realm (`registerAdapters`); "there is no way to load a plugin from a URL, a file or a store, on purpose" | `packages/browser/vite-plugin.ts`, `packages/browser/src/plugins/bundled.ts`, [SDK.md](../SDK.md#registration-a-plugin-not-a-registry-line) |
| Release builds bundle no plugin, by omission: the release workflow never sets `GHOSTLY_PLUGINS`; only the e2e configurations do | `.github/workflows/release.yml`, `e2e/playwright.config.ts` |
| Shared apps (`services/1`) let a contact open an app running on your computer, proxied over the chat's live link. Desktop opens it in a window of its own on the `ghostly-svc` scheme; the extension in a tab on `https://<service>.<peer>.invalid/` answered through `chrome.debugger`; the web app can do neither | [700](700-local-services.md), [701](701-http-services.md), `packages/core/src/pairedHttp.ts`, `apps/desktop/src/viewer.rs`, `apps/extension/src/background.ts`, [BROWSER.md](../BROWSER.md#opening-a-contacts-app) |
| On Desktop only the `main` window may call commands; every other window runs a contact's code and is refused, whatever the capabilities say | `apps/desktop/src/main.rs` (`only_main`), `apps/desktop/capabilities/default.json` (`windows: ["main"]`) |
| The app renders no iframe anywhere, and no element with `sandbox` | `apps/ui/src` (no match), `apps/ui/src/test/chat/linkPreview.test.tsx` asserts a preview makes none |
| Every client's CSP: web `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https: wss: …; frame-ancestors 'none'`; extension pages `script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; img-src …`; Desktop like the web plus `ipc:` and loopback. None sets `frame-src` or `child-src`, so the web and Desktop fall back to `default-src 'self'` for frames and the extension's pages do not restrict them | `apps/web/nginx-headers.conf`, `apps/extension/public/manifest.json`, `apps/desktop/tauri.conf.json`, `apps/ui/src/test/security/contentSecurityPolicy.test.ts` |
| The extension is Manifest V3 with no `sandbox` pages; the engine runs in an offscreen document | `apps/extension/public/manifest.json`, `apps/extension/src/background.ts` |
| Desktop updates are signed: the Tauri updater checks a minisign signature against a public key in the configuration, from a `latest.json` on GitHub releases | `apps/desktop/tauri.conf.json` (`plugins.updater`) |
| Cards under a message (invite, group, Nostr, identity) come from a parser of the text; at most 3 per message. Sender-made link previews ride with the message | `apps/ui/src/lib/parse/entities.ts`, `apps/ui/src/components/chat/EntityCards.tsx`, `apps/ui/src/lib/parse/linkPreview.ts`, [401](401-paired-chat.md) |
| A structured card (`sc`, at most 8 KiB, text as fallback) rides beside the text on every text path; today only bots send them (status cards, message buttons) | [4xx status cards](4xx-status-cards.md), [4xx message buttons](4xx-message-buttons.md), `packages/core/src/statusCards.ts` |
| `files/3` carries a file of any size with consent and resume; the receiver takes up to 25 MiB by itself and checks the SHA-256 of what it stored. Files are not content-addressed: the receiver stores them under its own id | [501](501-paired-files.md#files3-files-of-any-size-revision-03), `packages/browser/src/shared/fileBytes.ts` |
| The only profile-wide key is the DID key (did:dht). No chat uses it; it travels in backups | [3xx did:dht](3xx-did-dht.md), `packages/browser/src/engine/did.ts` |
| Identity proofs exist for Nostr, Pubky, domains, OpenPGP, Bitcoin addresses, SSH (including keys GitHub and GitLab publish), OpenID Connect (off in every build: no client IDs) and DIDs, and Bluesky | `packages/browser/src/proofs/registry.ts`, `packages/browser/src/proofs/sshForges.ts`, [300](300-peer-proofs.md) |
| Payments in a chat: `pay-req`, `pay`, `pay-res` frames with a network (`n`); rails Cashu, Lightning cards, Ark (Arkade, Bark), Spark, Fedimint, USDT, on-chain; Testnet has a faucet button; any Mainnet spend needs `confirmedReal` | [200](200-payments.md), `packages/core/src/frames.ts`, `packages/browser/src/engine/paymentAdapters/testCoins.ts`, `walletInstances.ts` (`assertConfirmedReal`), `apps/ui/src/components/ConfirmRealMoney.tsx` |
| Pkarr packets are at most 1000 bytes; web and extension reach them through two default relays; Desktop and the CLI also reach the Mainline DHT | `packages/core/src/pkarr.ts`, `packages/core/src/relay.ts` (`DEFAULT_RELAYS`), `apps/desktop/src/pkarr_network.rs` |
| The headless CLI is on npm as `@ghostlytools/cli`; small self-hosted services live in `infra/services/` (push relay, HyperDHT relay); the web app ships as a Docker image | `packages/cli`, `.github/workflows/npm-publish.yml`, `infra/services/`, `infra/docker-compose.yml` |
| Nothing in the code is a catalog, a store, a package or a mini-app. They exist only as roadmap rows | [ADAPTER-ROADMAP.md](ADAPTER-ROADMAP.md#plugins-apps-catalogs-and-ghostlyos) |

## What the outside world allows (sources)

Read on 2026-10-02. Each line names the page it rests on.

| Fact | Source |
|---|---|
| **Umbrel's store** is a Git repository with one folder per app, named by the app id, holding `umbrel-app.yml` (the manifest) and `docker-compose.yml`. The manifest has `manifestVersion`, `id`, `category`, `name`, `version`, `tagline`, `description`, `releaseNotes`, `developer`, `website`, `dependencies`, `repo`, `support`, `port`, `gallery`, `submitter`, `submission`; images are pinned by digest | [umbrel-apps packaging guide](https://github.com/getumbrel/umbrel-apps/blob/master/.agents/skills/umbrel-package-app/SKILL.md), [bitcoin/umbrel-app.yml](https://raw.githubusercontent.com/getumbrel/umbrel-apps/master/bitcoin/umbrel-app.yml) |
| Umbrel's official store takes apps by pull request, linted and reviewed by its team | the same guide, "PR Readiness" |
| A **Community App Store** is a Git repository with `umbrel-app-store.yml` (`id`, `name`); every app id starts with the store id; a person adds one by pasting the repository URL | [umbrel-community-app-store](https://github.com/getumbrel/umbrel-community-app-store) |
| Umbrel clones the default branch shallowly and re-clones when the remote head changes, every 5 minutes. **It checks no signature and pins no commit.** The default store cannot be removed. Its UI warns that community stores are not vetted and may be malicious | [app-repository.ts](https://github.com/getumbrel/umbrel/blob/master/packages/umbreld/source/modules/apps/app-repository.ts), [app-store.ts](https://github.com/getumbrel/umbrel/blob/master/packages/umbreld/source/modules/apps/app-store.ts), [en.json](https://github.com/getumbrel/umbrel/blob/master/packages/ui/public/locales/en.json) (`community-app-stores.warning`) |
| **Chrome Web Store, MV3:** remotely hosted code (JavaScript, WASM) may not run in the extension; remote data (JSON, CSS, images) may. Code run "in contexts that are isolated from extension APIs (such as iframes and sandboxed pages)" is exempt | [Remote hosted code](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code), [MV3 requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements) |
| An extension's **sandbox pages** get no extension APIs, talk by `postMessage` only, run under their own CSP, which must keep `sandbox` and may not add `allow-same-origin` | [manifest sandbox](https://developer.chrome.com/docs/extensions/reference/manifest/sandbox) |
| **Tauri 2:** the API is limited to bundled code by default; a capability may grant listed remote origins listed commands. On Linux and Android Tauri cannot tell a request from an embedded iframe from one by its window | [Capabilities](https://v2.tauri.app/security/capabilities/) |
| Tauri custom schemes are `<scheme>://localhost/` on macOS and Linux and `http://<scheme>.localhost/` on Windows | [tauri::Builder](https://docs.rs/tauri/latest/tauri/struct.Builder.html) |
| The Tauri updater's signature check cannot be turned off; it is minisign (Ed25519) | [Updater](https://v2.tauri.app/plugin/updater/), [updater Cargo.toml](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/updater/Cargo.toml) |
| A sandboxed iframe without `allow-same-origin` gets an opaque origin: no cookies, no `localStorage`. `allow-scripts` with `allow-same-origin` on a same-origin page can remove the sandbox. The CSP `sandbox` directive works only as an HTTP header | [MDN iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe), [HTML sandboxing](https://html.spec.whatwg.org/multipage/browsers.html#sandboxing), [MDN CSP sandbox](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox) |
| **GitHub from a browser** (checked with an `Origin` header): `raw.githubusercontent.com` answers `Access-Control-Allow-Origin: *` with `text/plain` and `nosniff`, so it can be fetched, not used as a script. `codeload.github.com` archives and release assets (`release-assets.githubusercontent.com`) send no CORS header, so a page cannot read them. `api.github.com` allows CORS and 60 unauthenticated requests per hour per IP | observed with curl on 2026-10-02; [REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) |
| **jsDelivr** serves `cdn.jsdelivr.net/gh/<user>/<repo>@<commit>/<file>` with CORS and `immutable` caching, and keeps commit-pinned files even after the repository is deleted; single files over 20 MB are not served | observed with curl on 2026-10-02; [jsDelivr README](https://github.com/jsdelivr/jsdelivr) |
| GitHub disables a repository about one business day after a DMCA notice that is not resolved; forks are not disabled automatically | [DMCA takedown policy](https://docs.github.com/en/site-policy/content-removal-policies/dmca-takedown-policy) |
| GitHub has been blocked by governments at times (China in 2013, Russia and India in 2014) | [Censorship of GitHub](https://en.wikipedia.org/wiki/Censorship_of_GitHub) (secondary) |
| **TUF** has four roles (root, targets, snapshot, timestamp) and addresses rollback, indefinite freeze, mix-and-match, malicious mirrors and key compromise below a threshold | [TUF specification](https://theupdateframework.github.io/specification/latest/) |
| **F-Droid** signs its index offline, with a timestamp and an expiry; a repository is defined by its signing key; third-party repositories are added by URL | [F-Droid security model](https://f-droid.org/docs/Security_Model/), [Setup an F-Droid app repo](https://f-droid.org/docs/Setup_an_F-Droid_App_Repo/) |
| **Zapstore** has each release signed by its developer's Nostr key and refuses an install on a hash mismatch. **Obtainium** installs from release pages by URL and adds no signature of its own | [zapstore.dev](https://zapstore.dev/), [Obtainium](https://github.com/ImranR98/Obtainium) |
| **Sigstore** binds short-lived certificates to an OpenID Connect identity and logs signatures in Rekor, a transparency log; **minisign** is Ed25519 with a signed comment that can carry a version | [Sigstore overview](https://docs.sigstore.dev/about/overview/), [minisign](https://jedisct1.github.io/minisign/) |
| Offline licences: Keygen's signed licence files are checked against the vendor's public key; L402 makes a token valid by a paid preimage. Neither binds a licence to the buyer's public key | [Keygen cryptography](https://keygen.sh/docs/api/cryptography/), [L402](https://docs.lightning.engineering/the-lightning-network/l402) |

## Terms

| Term | Meaning |
|---|---|
| **Publisher** | Whoever signs a package. Identified by an Ed25519 **publisher key**, nothing else |
| **Package** | One version of one app: files plus a signed manifest |
| **App reference** | `<publisher key>/<name>`. The identity of an app. Two packages are versions of the same app only when both are signed by the same publisher key (or a key it rotated to) and carry the same name |
| **Digest** | SHA-256 of a package's canonical manifest, which lists the SHA-256 of every file. One digest names every byte of a version |
| **Source** | Anywhere the bytes of a package can come from: a Git repository, a mirror, an indexer's copy, a file in a chat. Sources are not trusted: bytes are checked against the digest and the signature |
| **Catalog** | A curated list: a Git repository with a signed index of listings, each pointing at a package by source, pinned commit and digest. Run by a **curator**, who chooses what is in it |
| **Indexer** | A service that reads catalogs, Git hosts and packages people submit, and answers search, ranking, versions, reviews and malware reports. It lists; it does not curate on anyone's behalf |
| **Card** | How a package, a catalog or an indexer appears in a chat: a structured attachment to a message, with a link as its text |
| **Runner** | The small, trusted page of the client that hosts an app in its sandbox and passes its requests to the **broker** |
| **Broker** | The client code that answers an app's requests, each only within the permissions the person granted |

**An app is never identified by a catalog or an indexer.** Its reference is bound to its publisher key, so a lying catalog or indexer can hide an app or rank it, never swap its code.

## What an app and a plugin are

| Kind | What it is | Runs | Phase 1 | Why |
|---|---|---|---|---|
| **Mini-app** | A static web app (HTML, JavaScript, CSS, WebAssembly). Alone, or in a chat with the same app on the contact's side: chess, a poll, a shared list, a whiteboard | In a sandbox on the person's device, talking to the client only through the broker | **Yes** | It needs no key, no wallet and no engine object; the browser's sandbox can hold it; and it is the story people want (play in a chat) |
| **Theme** | Colours and the app's design tokens as data. No code | Read by the client, applied by its own code | **Yes** | Data only: no code runs, so nothing to sandbox. A first package that cannot hurt anyone tests the whole path |
| **Bot** | A program for the headless CLI ([11xx](11xx-headless.md)) that is a contact in chats | As a process on the publisher's or the person's server | No: phase 3 | Native code needs an operating-system sandbox, which the CLI does not have |
| **Adapter plugin** | A wallet source or an identity proof built with the SDK | In the engine, with every key | No: research | It has the app's privileges ([evidence](#what-exists-today-evidence)). Stays a build-time choice until a permissioned plugin host exists |
| **Transport** | A new way to connect | In the engine | Never a store item | A transport is a WISP and an app change ([SDK.md](../SDK.md#transports-and-a-minimal-client)) |

So **phase 1 carries mini-apps and themes**. "Plugin" in this document means an adapter plugin; the owner's "apps and plugins" become, in phase 1, apps that need no plugin host. The word stays in the family's name because adapter plugins join the same package and catalog format once they can run safely.

## The package

### Files and limits

A package is a folder:

```
ghostly-app.json        the manifest (signed)
ghostly-app.sig         the publisher's signature over the manifest's digest
index.html              the entry (a mini-app); a theme has none
...                     every other file the manifest lists
```

| Bound | Phase 1 |
|---|---|
| Files | At most 256 |
| Whole package | At most 16 MiB (under jsDelivr's 20 MB per file, and well over what a chat takes without asking: 25 MiB) |
| Manifest | At most 64 KiB |
| Paths | Relative, `/`-separated, `[A-Za-z0-9._-]` per segment, no `.` or `..` segment, no leading `/`, at most 128 bytes; no two paths equal ignoring case |
| Icon | `icon.png`, square, at most 256 KiB |

A client refuses a package that breaks any bound, before it shows anything but the refusal.

### Manifest

`ghostly-app.json`, UTF-8 JSON. Exact keys; an unknown key at the top level is refused, so a later version must raise `ghostlyApp`.

| Field | Required | Meaning |
|---|---|---|
| `ghostlyApp` | Yes | Format version: `1` |
| `publisher` | Yes | The publisher key: Ed25519, 32 bytes, z-base32 (as a Pkarr key) |
| `name` | Yes | `^[a-z][a-z0-9-]{0,31}$`, unique per publisher. With `publisher`, the app reference |
| `version` | Yes | Semantic version, shown to people |
| `sequence` | Yes | An integer that rises with every version. Rollback protection compares it, never `version` |
| `kind` | Yes | `mini-app` or `theme` in phase 1 |
| `title`, `tagline`, `description` | Yes, yes, no | What people read: 40, 80 and 2000 characters at most |
| `entry` | For a mini-app | The entry file, usually `index.html` |
| `permissions` | Yes, may be empty | What the app asks for ([Permissions](#permissions)) |
| `runtime` | Yes | `{"host": ">=1.2", "clients": ["web", "extension", "desktop"]}`: the lowest Ghostly version, and the clients it was tested on |
| `license` | Yes | An SPDX expression, or `proprietary` |
| `sources` | No | Where to look for updates: Git repository URLs and HTTPS base URLs, in order. Without it the app gets updates only when someone hands it a newer version |
| `homepage`, `support` | No | HTTPS URLs |
| `price` | No | Phase 2 ([Paying](#paying)). Absent means free |
| `recovery` | No | A second Ed25519 key, kept offline, that may rotate or revoke ([Keys](#publisher-keys-rotation-and-revocation)) |
| `files` | Yes | Every file but the manifest and the signature: `{"path", "size", "sha256"}`, sorted by path, SHA-256 in base64url |

### Canonical bytes, digest and signature

- The **canonical manifest** is the manifest serialized by the JSON Canonicalization Scheme ([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)).
- The **digest** is the SHA-256 of those bytes.
- `ghostly-app.sig` is `{"alg": "ed25519", "key": "<publisher key>", "sig": "<base64url>"}`, where `sig` signs the bytes `ghostly-app/1` + a zero byte + the 32-byte digest. The prefix keeps a package signature from being reused as any other signature made by the same key.
- A package is **valid** when the manifest holds every bound, the signature verifies under `publisher` (or a key the client accepted by rotation), and every file's bytes match its size and hash. A client checks all of it before it stores a package, and checks the files again before it runs one.

Before this draft becomes Proposed, these bytes get test vectors.

### The bundle: a package as one file

To send a package in a chat, or to mirror it, the package is one file, a **bundle** (`.ghostlyapp`): the bytes `GHOSTLYAPP1`, then the canonical manifest and the signature file, each preceded by its length (32-bit, big-endian), then every file's bytes in the order of `files`. The sizes in the manifest delimit the files, so there is no archive format to parse and no path inside the bundle that the manifest did not name. A reader stops at the first byte past what the manifest declares.

### Publisher keys, rotation and revocation

- A publisher key is **not a profile key**. The CLI makes and keeps it (`ghostly app key`, phase 1), so a developer's chat profile never signs packages, and a package signing key never sits in a browser.
- A publisher may link the key to identities people know, with public proofs: a `ghostly-publisher.json` in the repository holding proofs of [300](300-peer-proofs.md)'s kinds that work in public (a domain, a Nostr key, an SSH key GitHub publishes, a DID). A card then shows "Published by 7f3k…q9a · github.com/ana" only for what verifies. A repository's URL alone proves nothing about the key.
- **Rotation:** a statement `{"rotate": "<new key>", "app": "<name>", "sequence": n}` signed by the old key, or by the `recovery` key, moves the app to the new key from that sequence on. The client keeps the chain.
- **Revocation:** a statement signed by the publisher key or the recovery key, naming digests or "every version up to sequence n". A client that sees it stops those versions and tells the person.
- **A compromised key without a recovery key** cannot be fixed inside the format. The publisher starts a new app under a new key, and catalogs and indexers say so. This is the price of not running a root of trust; [Updates](#updates-and-rollback) says what TUF would add.

### Updates and rollback

A client stores, per installed app, the publisher key (and its rotation chain), the highest `sequence` it has seen and the digest of that version.

- **An update is any valid package of the same app with a higher `sequence`.** Where it came from does not matter: the publisher's Git repository, a catalog, an indexer, a contact. The bytes are checked, not the messenger.
- **Rollback:** a package with a lower `sequence` is never installed over a higher one. The same `sequence` with a different digest is **equivocation**: the client refuses both, keeps what it runs, and marks the app for the person ("Two different versions 7 exist. Ghostly kept the one you have.").
- **Where the client looks:** the manifest's `sources`, then the catalogs and indexers the person added. It never asks the contact who sent the app.
- **When:** at start and every 24 hours, and when the person opens the Apps page. Never in the background on a metered connection, where the client can tell.
- **Freeze** (every source serves an old version): partly covered. A catalog's index expires ([Catalogs](#catalogs-git-repositories)), so a frozen catalog is noticed; a frozen publisher repository is not, until phase 2's publisher record: a Pkarr record under the publisher key, republished by the publisher's CLI, naming each app's latest `sequence` and digest.
- **Uninstall** removes the files and the app's storage after a confirmation that names what the app stored. **Export** of an app's storage is offered first, so a store or a publisher that disappears does not take a person's data.

**TUF, evaluated honestly:**

| TUF piece | What it gives | Fits Ghostly? | Taken here |
|---|---|---|---|
| Root role, threshold of keys | Survives a compromise of some keys | A single developer rarely holds several keys. The `recovery` key is a threshold of one, offline | The idea: an optional offline key that rotates and revokes |
| Targets role | Which files, by hash | Yes | The manifest's `files` |
| Snapshot role | Stops mix-and-match across many targets files | One package has one manifest; a catalog has one index | Not needed per package; the catalog index plays it |
| Timestamp role, short expiry | Detects freeze | Needs an online key signing often, a server in effect | Catalog index expiry now; the publisher's Pkarr record in phase 2 |
| Delegations | A repository delegates paths to developers | A catalog lists packages signed by their publishers: delegation by reference | The listing points to a publisher's signed package |
| Its metadata format and client libraries | Interoperable, reviewed | Needs one repository authority; Ghostly has many publishers and many catalogs, none in charge | No. A smaller format of TUF's ideas, as F-Droid and Zapstore also chose |

Revisit TUF when one catalog grows large enough to need delegated roles of its own, and a transparency log for publisher keys (as Sigstore's Rekor) when key compromise is seen in the wild. Both are research.

### Permissions

A mini-app gets nothing by default but its frame and the broker. Phase 1 has these permissions:

| Permission | What the app may do | Shown at install as |
|---|---|---|
| none | Draw in its frame; keep up to 5 MiB of its own data through the broker | "Uses no data from you" |
| `chat` | Exchange messages with the same app on the contact's side, in the chat where the person opened it, while the chat is live ([In a chat](#in-a-chat-apps1)) | "Talks to the same app on your contact's side" |
| `name` | Read the person's display name in that chat | "Sees your name in the chat" |

Later phases add, each with its own line: `network` (a list of HTTPS origins, which the runner adds to its CSP), `payment-request` (asks the client to show a payment the person approves; the app never sees a wallet, a balance or a key, as the [roadmap](ADAPTER-ROADMAP.md#plugins-apps-catalogs-and-ghostlyos) requires), `clipboard-write`, `camera`, `microphone`, `notify`.

**What re-asks:** an update that adds a permission, adds a network origin or changes `kind` waits for the person, who sees only what is new. An update that removes something applies by itself. A rotation to a new publisher key shows "<app> has a new publisher key" with the rotation's signer, once. A theme has no permissions.

**What never happens:** an app that runs before the person pressed Install; a permission granted by a catalog, an indexer or a contact; a permission granted for all apps at once.

## Where it runs

### The runner, the same on every client

The runner is a small page shipped inside the client (never fetched). It runs **in a sandbox with an opaque origin**: no cookies, no `localStorage`, no access to the client's pages. The client sends it the verified files with `postMessage` (as transferable buffers). The runner makes `blob:` URLs of them itself, writes an import map from the package's paths to those URLs, and then writes the entry document. Inline scripts, modules imported by relative path, styles, images, fonts, media and WebAssembly work. Fetching a package path with `fetch`, workers loaded by path and service workers do not: the app asks the broker (`ghostly.file(path)`) instead. The SDK's mini-app template builds within these rules.

The runner's CSP, sent as a header where the client can (so the `sandbox` directive holds too):

```
sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' blob: 'wasm-unsafe-eval';
style-src 'unsafe-inline' blob:; img-src blob: data:; media-src blob: data:; font-src blob: data:;
connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'
```

`connect-src 'none'`: in phase 1 a mini-app reaches no network at all. Everything goes through the broker, which answers only what the granted permissions allow, with bounded sizes and rates (at most 64 KiB per message, 50 messages a second).

### Per client

| Client | Today | Phase 1 | Limits |
|---|---|---|---|
| **Web** (and the installed web app on phones) | No frames, no packages. `default-src 'self'` already allows a frame of the app's own origin | An `<iframe sandbox="allow-scripts">` of `/app-frame.html` from the app's own server, in the chat or full screen. Its own CSP header (above), set by a location of its own in `apps/web/nginx-headers.conf`; the main page's CSP does not change. Packages are fetched from `raw.githubusercontent.com` (CORS allowed), jsDelivr or an indexer's copy, never from release assets (no CORS) | The frame shares the browser process with the app (no process isolation is assumed). A self-hoster whose server cannot set a second header gets no mini-apps: the client checks the frame's policy before it loads one |
| **Extension** | MV3, no sandbox pages | A **sandbox page** (`sandbox.pages` in the manifest) as the runner, framed in the chat. Its CSP is the manifest's `content_security_policy.sandbox`: the line above, which keeps `sandbox` and never adds `allow-same-origin`. Remote code in a sandboxed page is exempt from the store's remote-code rule ([sources](#what-the-outside-world-allows-sources)) | The store's reviewers judge the listing, so the listing must say that apps the person installs run sandboxed. [BROWSER.md](../BROWSER.md#opening-a-contacts-app) rejected a sandbox page for shared apps because their pages need a service worker; a package does not, since the runner holds every file |
| **Desktop** | `ghostly-svc` windows for shared apps, refused every command | A **window of its own** per running app, served by a new scheme `ghostly-app` (`ghostly-app://localhost/` on macOS and Linux, `http://ghostly-app.localhost/` on Windows) whose handler serves the runner and its CSP header. `only_main` refuses its commands, as for `ghostly-svc` | Not a frame in the main window in phase 1: on Linux Tauri cannot tell a frame's requests from its window's ([sources](#what-the-outside-world-allows-sources)), and `only_main` checks the window, not the frame. A frame in the chat on Desktop waits for a test that shows no command answers it |
| **CLI** | No UI | Publisher tools only: `ghostly app key`, `init`, `sign`, `verify`, `bundle` | No mini-apps and no themes run there |

**Themes** are read by the client as data on every client with a UI; a theme's values are checked against the app's token list and colour contrast rules before they apply.

### In a chat: `apps/1`

A mini-app with the `chat` permission can talk to the same app on the contact's side.

- `apps/1` is a session capability ([03](03-capabilities.md)) of the live chat session ([401](401-paired-chat.md)). Frames: `{"t": "app", "a": "<chat app id>", "d": "<data>"}`, `d` at most 64 KiB, dropped unless both sides offer `apps/1`.
- `<chat app id>` is HMAC-SHA-256 of the app reference, keyed with a secret of this chat, cut to 16 bytes. Both sides compute the same id; nobody outside the chat learns which app it is.
- **Nothing is advertised.** A client never lists its installed apps to a contact (unlike `hello.svc` for shared apps). The reference crosses only when the person opens an app in a chat: the client then sends an app card ("Ana opened Chess") with the package's pointer, and the contact installs or opens it.
- Two different versions talk if the app says so: the broker hands both sides each other's `version`; the app decides.
- Not on the DHT text path, not in groups in phase 1. Groups come with phase 2, over the group's own frames.

## Discovery without a central server

There are three ways to an app, and they are equal: a **catalog** someone curates, a **card** someone sends in a chat, and an **indexer** someone runs. A person can also paste the Git URL of a single app. Whatever the way, the package is checked the same.

### Catalogs: Git repositories

The owner asked for Umbrel's model, where people install by pasting GitHub URLs. It holds up, with three changes: Ghostly verifies signatures and pins commits where Umbrel does neither, and the code is not in the catalog.

**Layout of a catalog repository:**

```
ghostly-catalog.json            the index (signed)
ghostly-catalog.sig             the curator's signature
apps/<name>.<publisher-prefix>/
  listing.json                  where the package is: source, pinned commit, path, digest
  ghostly-app.json              a copy of the package's signed manifest
  ghostly-app.sig
  icon.png, gallery/*.png       what the Apps page shows
```

`<publisher-prefix>` is the first 8 characters of the publisher key, so two publishers' "chess" never collide in one catalog.

**`ghostly-catalog.json`:** `{"ghostlyCatalog": 1, "curator": "<key>", "name", "description", "sequence", "expires", "apps": [{"ref", "digest", "sequence"}], "removed": [{"ref", "digest", "reason", "at"}]}`, signed like a manifest (prefix `ghostly-catalog/1`). `expires` is at most 90 days ahead; an index past its expiry still installs what it lists, but the Apps page says "<catalog> was not updated since <date>". A lower `sequence` than the one the client holds is refused (rollback).

**`listing.json`:** `{"source": "https://github.com/ana/chess", "commit": "<40 hex>", "path": "dist", "digest": "<base64url>", "mirrors": ["https://cdn.jsdelivr.net/gh/ana/chess@<commit>/dist"]}`, or `"bundle": "<path of a .ghostlyapp in this repository>"` for a catalog that keeps the bytes itself.

**Adding by paste.** Apps page, "Add from a link". The person pastes `https://github.com/<owner>/<repo>`, optionally `/tree/<branch, tag or commit>`. The client:

1. resolves a branch or a tag to a commit with one `api.github.com` request (60 an hour per IP are free; a catalog's listings already name commits, so they cost none);
2. reads `ghostly-catalog.json` or `ghostly-app.json` at that commit from `raw.githubusercontent.com`;
3. shows the catalog (curator key, name, number of apps) or the app (its card), and adds or installs only when the person confirms.

**What pinning to a commit buys.** The listing names the exact commit the curator looked at. A force-push to a tag, a new commit on the default branch or a repository taken over by someone else cannot change what the listing installs: the bytes must hash to the digest. Git's own commit ids (SHA-1) are not what the client trusts; the SHA-256 digest in the signed manifest is. Pinning also makes the bytes immutable on jsDelivr, which keeps commit-pinned files even after the repository is deleted.

**If GitHub takes a repository down, or is blocked:**

| What | Effect |
|---|---|
| Installed apps | Keep working. The client runs its stored copy; nothing phones home |
| Updates | Come from any other `sources` entry, any catalog's mirror or any indexer's copy, checked the same way. A publisher moves by adding a source in a new version |
| New installs | From mirrors (jsDelivr by commit, any static host), an indexer's copy, or a bundle a contact sends. The digest makes every source equal |
| A blocked country | The same paths, plus a bundle sent in a chat, which needs no web host at all |
| Any Git host | Phase 2: GitLab, Codeberg, a self-hosted Forgejo, by their raw file URLs. Phase 1 is GitHub and plain HTTPS base URLs (a folder on any static host) |

**Umbrel and Ghostly, side by side:**

| | Umbrel | Ghostly (this draft) |
|---|---|---|
| What is installed | Docker containers on a server the person owns | Static web files in a sandbox on each device; no server |
| Where the app's code lives | In the store repository (compose file, images by digest) | In the publisher's repository; the catalog points to it by commit and digest |
| How it is fetched | `git clone` on the server | HTTPS file reads from a browser (CORS decides), or from Rust on Desktop |
| Signatures | None | Publisher signature on every package, curator signature on every catalog |
| Pinning | None: the default branch's tip, polled every 5 minutes | Commit and digest per listing; `sequence` per package |
| Community stores | Pasted Git URL, ids prefixed by store id | Pasted Git URL; ids bound to publisher keys, not to stores |
| Default store | Cannot be removed | Preloaded, and can be removed like any other |
| Warning on community stores | Yes | Apps are checked by publisher key whatever the catalog; the page names the catalog and the publisher every time |

### Apps sent in a chat

The owner wants people to send apps to each other, so installing never depends on one store. A chat is a source like any other.

**Two forms:**

- **A pointer card.** The person shares an app (Apps page, "Share", or pasting a Git URL that holds an app). The sender's client attaches a card to the message, as it attaches a sender-made link preview: `{"kind": "app", "ref", "title", "version", "sequence", "digest", "source", "commit", "path", "mirrors"}`, at most 8 KiB, in the message's `sc` field ([4xx status cards](4xx-status-cards.md)) with the URL as the text. An older app shows the link. It works on every text path, the DHT included, since the bytes are fetched later.
- **A bundle.** The person sends the `.ghostlyapp` file itself with `files/3` ([501](501-paired-files.md)). The receiver's client recognizes the bundle by its first bytes and shows the same card on the file bubble. The files' consent rules hold: up to 25 MiB arrives by itself, and **arriving is not installing**.

**What the receiver sees** on the card: icon, title and version; "Published by <publisher fingerprint>" with the publisher's proofs that verify; "Sent by <contact>"; the permissions, one line each; the digest's first characters; and one of "Signed", "In <catalog>", "Not in any of your catalogs", "Marked as malware by <source>". Buttons: "Install" (or "Open" when installed) and "Details".

**The sender is not the publisher.** A card or a bundle is carried, not vouched for. A forwarded signed package keeps its publisher's signature; a forwarder cannot change a byte without breaking it. The card says "Sent by Ana", never "Ana's app". To vouch, a person writes a review ([Reputation](#reputation)), which can itself be shared as a card.

**Updates** of an app received in a chat come from the manifest's `sources` and from the person's catalogs and indexers, never from the sender. A newer version that arrives later in any chat is taken as an update only if it is valid, of the same app and higher in `sequence`. An app with no `sources` says "Updates only when someone sends you a newer version".

**What keeps a chat from becoming a malware channel:**

- An unsigned package, or one whose signature or files do not verify, is refused: the card says "Not signed. Ghostly won't install it." There is no "install anyway". A developer signs test builds with a throwaway key from the CLI.
- Nothing installs or runs from a card by itself. Install is a button on the receiver's side, then the permissions screen.
- The same sandbox and the same broker as any app.
- The revocation lists of the person's catalogs and indexers are checked before the install button is enabled, and again at every update check.
- At most 3 cards per message, as for other cards.

**Catalogs and indexers are shareable the same way.** A catalog's URL in a message gets a catalog card ("Catalog · <name> · 24 apps · curated by <fingerprint>", "Add catalog"); an indexer's gets an indexer card ("Indexer · <name>", "Add indexer"). The sender's client makes the card by reading the URL, like a link preview; the receiver's client reads it again before adding anything.

This is what makes **the default catalog one source among many**: an app spreads from person to person, a catalog spreads the same way, and the client gives the default no power the others lack.

### Indexers

A **catalog** is a list someone curates and signs. An **indexer** is a service that reads many catalogs, Git hosts and submitted packages, and answers questions about them: search, ranking, versions, reviews, malware reports. A catalog says "I recommend these". An indexer says "Here is what exists, and what people say about it". One person can run both; the client keeps them apart.

**The person chooses.** Apps page, "Indexers": the default one plus any URL, added by paste or from a card. Several at once. Results are merged by app reference, and every result shows where it came from: "via <indexer> · in <catalog>". When indexers disagree (versions, reports), the page shows both.

**An indexer cannot change what is installed.** It hands back references and pointers. The package is verified by its publisher's signature and digest, as from anywhere. A lying indexer can hide an app, rank it, or show false reviews; it cannot swap code.

**The API** is read-only HTTP and JSON, `Access-Control-Allow-Origin: *`, no cookies, no accounts:

| Path | Answer | Required |
|---|---|---|
| `GET /ghostly-index.json` and `/ghostly-index.sig` | The whole index, signed by the indexer's key, with `sequence` and `expires`: per app its reference, title, tagline, kind, latest `sequence` and digest, pointers, the catalogs that list it, report counts, and `promoted` when someone paid for its place | Yes |
| `GET /v1/search?q=` | Matching entries, same shape | No: only for an index too large to download |
| `GET /v1/apps/<ref>` | Every known version, pointers, the indexer's notes | No |
| `GET /v1/reviews/<ref>` | Signed reviews it collected | No |
| `GET /v1/reports` | Signed malware reports it collected, and its own verdicts | No |
| `GET /v1/bundles/<digest>` | A copy of a package's bundle, served by digest | No |
| `POST /v1/submit` | A pointer or a bundle someone asks it to index, a review, a report | No |

**An indexer can be just files.** The required part is two static files, so an indexer can live on GitHub Pages or any static host, and a script can build it. Phase 2 adds an optional Pkarr record under the indexer's key naming its current URL and `sequence`, so it can move host without its users noticing.

**Privacy.** An indexer sees the IP address and the time of every request, and every search query. So the client **downloads the whole index and searches locally** while it is at most 4 MiB compressed, which covers thousands of apps. Search on the indexer's side is used only above that, and the page says so ("Searching on <indexer>: it sees what you type"). Installing from a pointer reveals nothing to an indexer: the bytes come from the source.

**Paid ranking** is allowed and marked. An entry with `promoted` shows "Promoted by <indexer>" wherever it appears; the merged list sorts by the client's own relevance, never by one indexer's order across others' results. An indexer that hides `promoted` is lying, which only other indexers and reviews can expose.

**Ghostly's default indexer** is open source, in this repository (`infra/services/indexer`, planned), with a Docker image like the web app's, so anyone can run one (an Umbrel package is a candidate, as for the self-hosted runtime). It indexes the catalogs it is configured with and what people submit. It does not crawl chats: it cannot, and must not. The maintainers run one instance at a URL the client preloads; the person can remove it. This is the roadmap's "Multiple indexers" row, made concrete.

### Takedowns and malware reports, with no authority

Nobody can remove an app from everyone's device, and nobody should. What exists instead:

- **A curator** removes a listing and adds it to the index's `removed` list with a reason.
- **An indexer** publishes its verdicts in `/v1/reports`.
- **A publisher** revokes its own versions ([Keys](#publisher-keys-rotation-and-revocation)).
- **The client** checks, at every update check, the lists of the sources the person added. When one marks a digest the person has installed as malware, the app is **stopped** and the person decides: "<source> marks <app> as malware: <reason>." Buttons: "Remove", "Keep it stopped", and, behind "Details", "Run anyway". A publisher's own revocation stops it with no "Run anyway".
- **A report** is a signed statement `{"report": "<ref>", "digest", "category", "text", "reporter": "<key>"}` sent to an indexer ("Report" on the app's page). The client never sends one without the person writing it.

A source the person did not add has no effect on their device. Different catalogs can disagree, and the page shows the disagreement.

## Paying

Phase 2. Nothing below runs in phase 1, which is free apps only.

**Rails.** The chat payments that exist ([200](200-payments.md)): Cashu first, since it works on every client and has a test mint and a faucet button; Lightning through the person's Lightning card. Test networks first ("Testnet" in the app); Mainnet only after the soak the owner decides, and every Mainnet purchase passes the `confirmedReal` gate as any spend does.

**How a purchase happens, with no server of Ghostly's.** A paid manifest's `price` is `{"amount": 2100, "unit": "sat", "seller": "<ghostly1 invite>"}`. The seller is a **sales bot**: the publisher's headless CLI ([11xx](11xx-headless.md)), a contact like any other. "Buy" opens a chat with it; the bot sends a `pay-req`, the person pays it in the payment sheet they know, and the bot answers with a licence and, optionally, message buttons ([4xx](4xx-message-buttons.md)) for support or refunds. Everything rides on the chat that exists. The publisher must keep the bot reachable; a purchase made while it is away waits in the chat like any message.

**The licence.** `{"ghostlyLicence": 1, "app": "<ref>", "holder": "<licence key>", "versions": "<range>", "issued", "payment": "<hash of the pay frame>"}`, signed by the publisher key (prefix `ghostly-licence/1`). The holder key is **derived per profile and per publisher**: HKDF-SHA-256 of the profile's DID seed with the info `ghostly-licence/1` and the publisher key. So:

- a publisher cannot link one buyer's purchases from other publishers;
- the licence follows the profile into backups ([05](05-backups.md)) and across a handoff between the profile's devices ([06](06-devices.md)), because the seed does;
- it is **per profile, not per device**: with [06](06-devices.md) one device is active at a time, so a licence per device would break at every handoff.

**What a licence gates, honestly.** The client installs and updates a paid app only with a valid licence, checked offline against the publisher key. That is all. The files of a paid app published in a public repository can be copied and run in a modified client. A publisher who wants more can keep the paid files out of public sources and have the bot deliver them, encrypted to the holder key; once decrypted they can still be copied. Ghostly promises no DRM.

**Offline:** a licence is checked locally; nothing phones home. **Refunds:** the publisher's policy, shown on the listing; a refund is a payment back in the same chat. A publisher may revoke a licence for future updates; the installed version keeps running. **Key loss:** the licence is lost with the profile when there is no backup. The publisher may reissue to a new holder key on whatever proof they accept; the chat with the bot is that proof's natural place. **Payment fraud:** a publisher that takes the money and sends no licence cannot be undone by Ghostly. Small amounts, Testnet first, and reviews are the protection, and the buy screen says it: "Paid to <publisher>. Ghostly can't refund it."

## Reputation

- **A review** is `{"ghostlyReview": 1, "app": "<ref>", "digest", "rating": 1-5, "text" (2000 characters), "at", "reviewer": "<key>"}`, signed. The reviewer key is derived per profile (info `ghostly-review/1`): a pseudonym that is the same across the person's reviews, so a reader can weigh a history, and that the person may link to an identity with a proof, or not.
- **Who reviews:** anyone. Indexers collect reviews; a person can also share a review in a chat as a card.
- **What the client shows**, in order: reviews from the person's contacts (a review card received in a chat is shown as that contact's); then each indexer's reviews, labelled by indexer, with counts per indexer. It never adds counts from different indexers into one number.
- **Sybil resistance:** the client computes no global score. It does not count followers, and it does not weigh reviews by payment: "Bought it" may be shown as a fact on a review whose reviewer holds a licence, never used as weight. An indexer may filter spam as it likes, and says how in its own page.
- **Conflicts are shown**: "In <catalog> · <indexer> has 3 malware reports".

## Security and privacy

### Threats

| Threat | What limits it | What remains |
|---|---|---|
| A malicious app | The sandbox (opaque origin, no network, no extension APIs, no Desktop commands), the broker's permissions and bounds, Install pressed by the person | A sandbox escape in the browser or webview. Phishing inside the frame (a fake "enter your seed" form): the runner frames apps in a visibly different container, and the client never asks for secrets inside an app's area |
| A malicious update | Signature by the same key, `sequence` rising, new permissions re-asked, revocation lists checked | An update that misbehaves within permissions already granted |
| A compromised publisher key | Rotation and revocation by the `recovery` key when there is one; catalogs and indexers mark the app | Without a recovery key: every holder of the app trusts the attacker's next version until a source the person added says otherwise |
| A malicious catalog | It can list only packages that verify under their own publishers' keys; listings show their catalog | It can list harmful apps signed by harmful publishers; curation is its whole value |
| A malicious or lying indexer | It cannot change bytes; it is labelled on every result; several indexers can be compared | Hiding apps, false reviews, unmarked promotion |
| A catalog or indexer that censors | Other catalogs, other indexers, a pasted URL, a card in a chat | Discovery is harder for the censored app |
| GitHub removes or blocks a repository | Stored copies, mirrors, jsDelivr by commit, indexer copies, chat bundles | New installs need someone who has the bytes |
| An app sent in a chat as bait | Same verification, no auto-install, "Sent by" is not "published by", unsigned refused | A person who installs a signed but harmful app from a stranger |
| A rollback or freeze | `sequence` per app, catalog `sequence` and `expires` | A frozen publisher repository, until phase 2's publisher record |
| Equivocation (two packages with one `sequence`) | Both refused, the app marked | None beyond the publisher's reputation |
| Payment fraud | Testnet first, small amounts, reviews, the buy screen's warning | No refund by Ghostly, ever |
| A bug in the runner or the broker | Small trusted code, tests for every message type, bounded sizes | It is the boundary; it gets the review of security-sensitive code |

### What each party learns

| Party | Learns |
|---|---|
| GitHub, jsDelivr, any source | The IP address and which package files are fetched, when |
| An indexer | The IP address and time of each index download; search queries only above the local-search size; what is submitted to it |
| A catalog's host | The IP address of each index fetch |
| A contact | Only the apps the person opens in a chat with them, or shares |
| Pkarr relays (phase 2) | Which publisher and indexer records are read |
| A publisher (phase 2) | A buyer's chat key with the sales bot and a per-publisher holder key; nothing that links purchases across publishers |
| Ghostly's maintainers | Nothing beyond what their default catalog host and indexer see, like any other operator |

### Before phase 1 ships: the tests that must exist

- A package that breaks each bound, each path rule, each canonical-bytes rule: refused, with nothing stored.
- A bad signature, a wrong file hash, a truncated bundle, a bundle with bytes past the manifest: refused.
- A lower `sequence`, an equal `sequence` with another digest: refused and marked.
- A malicious mini-app suite: reading cookies or storage, reaching the network, navigating the top window, opening popups, posting to the client's other windows, calling a Desktop command, calling extension APIs, flooding the broker, posting oversized messages. Every one fails, on each client.
- The extension's sandbox page CSP and the web's `/app-frame.html` header checked by `contentSecurityPolicy.test.ts`.
- A card with an unsigned package: no install button.
- A revocation from an added catalog stops a running app; one from a source not added does nothing.
- An e2e: two people, one sends a chess bundle in a chat, the other installs it and they play over `apps/1`, on web and Desktop.

## Compatibility and rollout

All additive. An older app sees an app card as its text (a link), a bundle as a file, and ignores `apps/1`, which it never offers. Nothing changes in records, invites, groups or payments. The web server gets one location with its own header; the extension's manifest gets a sandbox page; Desktop gets one scheme.

## Phases

### Phase 1 (after 1.1): the smallest useful store

**Free mini-apps and themes, installed from a pasted GitHub URL, a catalog or a card in a chat, on the web app, the extension and Desktop.** In pieces that can each be a pull request:

1. **Format and publisher tools.** The manifest, canonical bytes, digest, signature and bundle, with test vectors, in `packages/core`. `ghostly app key | init | sign | verify | bundle` in the CLI. A mini-app template in the SDK.
2. **The package store.** Verified packages kept per profile (the database on web and extension, app data on Desktop), with the installed state, `sequence` and permissions. Install, update, uninstall with export.
3. **The runner and the broker.** `/app-frame.html` with its header on web; the sandbox page on the extension; the `ghostly-app` scheme and window on Desktop. The broker with storage, `name` and `chat`. The malicious mini-app suite.
4. **The Apps page.** Installed apps, "Add from a link", catalogs, indexers, permissions, updates, the malware screen.
5. **Catalogs.** Paste and add; the index, its signature, `sequence`, `expires` and `removed`; reading from GitHub raw and jsDelivr.
6. **In a chat.** The app card in `sc`, the bundle recognized on a file bubble, the catalog and indexer cards; `apps/1` and the "opened Chess" card.
7. **Ghostly's default catalog and indexer.** A Git repository curated by the maintainers, its key and its listing policy; the indexer as a script and a Docker image in `infra/services/indexer` producing the static signed index, whole-index mode only.
8. **Themes**, as data, on every client with a UI.

Phase 1 has no payments, no reviews, no network permission for apps, no groups and no adapter plugins.

### Later phases and research

| Phase | What it gives |
|---|---|
| 2 | Paid apps on Testnet, then Mainnet when the owner says: the sales bot, licences, refunds by chat. Signed reviews and reports. The publisher's Pkarr record (freeze detection, hosts that move). Indexer search, `v1` paths and the indexer's Pkarr record. The `network` and `payment-request` permissions. Mini-apps in groups. Any Git host |
| 3 | Bots for the CLI as signed packages, run as separate processes under an operating-system sandbox where one exists. A frame in the chat on Desktop, once tested on Linux. Package sources over peer-to-peer content addressing (Iroh blobs, HyperDHT) |
| Research | A permissioned host for adapter plugins (WebAssembly components get only the capabilities the host gives them, [component model](https://component-model.bytecodealliance.org/)); a transparency log for publisher keys; reproducible-build checks by catalogs, as F-Droid does; TUF for a catalog that needs delegated roles |

## Decisions and open questions

**Decided by this draft:** the new family `12xx`; mini-apps and themes first; adapter plugins out of the store until a plugin host; publisher keys separate from profile keys; a smaller signed format than TUF, with `sequence`, expiry and an optional recovery key; catalogs as Git repositories pinned by commit and digest; chat sharing as a first-class source; indexers that list but never decide what installs; licences per profile, derived per publisher.

**Still open, for the owner:**

1. **Paid apps in phase 1?** This draft says no: phase 1 is free, so the format, the sandbox and the sources are proven before money moves. Recommendation: phase 1 free; phase 2 paid on Testnet; Mainnet when you say go.
2. **Who holds the default catalog's key, and what is the listing policy?** Recommendation: you hold the curator key offline (signing from the CLI on your machine), apps enter by pull request to the catalog repository as Umbrel does, and a short written policy says what is refused (malware, impersonation, apps that ask for secrets).
3. **Can a card from a contact install an app that is in none of the person's catalogs?** Recommendation: yes, with "Not in any of your catalogs" on the card. Refusing it would make the default catalog a gatekeeper again, which is what sending apps in a chat is meant to avoid.
4. **The extension in phase 1.** The store's policy exempts sandboxed pages, but a reviewer may still question a feature that runs code the person installs. Recommendation: build it in phase 1 with the listing's text saying how apps are sandboxed, and if a review refuses it, ship the extension without apps and keep web and Desktop.
5. **Network access for mini-apps.** Recommendation: none in phase 1; phase 2's `network` permission lists exact HTTPS origins, shown at install and re-asked when one is added.
6. **Who runs the default indexer, and where?** Recommendation: the maintainers, from the same Docker image anyone can run, on a host separate from the web app's, with a public statement of what it logs (nothing beyond what a static host logs by default).

## Conformance (candidate)

A client that implements this WISP MUST:

- install, update or run a package only when its manifest holds every bound, its signature verifies under the app's publisher key (or a key reached by a verified rotation), and every file matches its size and hash;
- identify an app by publisher key and name, never by a catalog, an indexer or a URL;
- never install a lower `sequence` over a higher one, and refuse two packages of one app with the same `sequence` and different digests;
- look for updates only in the manifest's `sources` and the sources the person added, never at the contact who sent the app; take a valid newer version from anywhere;
- show the permissions before installing, re-ask when an update adds one, and grant none on behalf of a catalog, an indexer or a contact;
- run a mini-app only in the runner: an opaque origin, the CSP above, no extension APIs, no Desktop commands; answer the app only through the broker, within its permissions and bounds;
- never install or run anything from a chat card or a bundle by itself, and refuse unsigned packages;
- never advertise installed apps to contacts;
- check the revocation lists of the sources the person added before an install and at every update check, and stop an app a publisher revoked;
- show, for every listing and result, the catalog or indexer it came from, and mark `promoted` entries;
- refuse a catalog or indexer index with a lower `sequence` than the one it holds, and say when one is past `expires`.

## References

[SDK](../SDK.md), [browser boundaries](../BROWSER.md), [roadmap](ADAPTER-ROADMAP.md#plugins-apps-catalogs-and-ghostlyos), [local services](700-local-services.md), [HTTP services](701-http-services.md), [chat session](401-paired-chat.md), [chat files](501-paired-files.md), [status cards](4xx-status-cards.md), [message buttons](4xx-message-buttons.md), [payments](200-payments.md), [identity proofs](300-peer-proofs.md), [devices](06-devices.md), [headless](11xx-headless.md). Outside sources are in [What the outside world allows](#what-the-outside-world-allows-sources); also [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) (JSON canonicalization) and [RFC 5869](https://www.rfc-editor.org/rfc/rfc5869) (HKDF).

## Revision log

One file per change in [changes/12xx-marketplace/](changes/12xx-marketplace/) ([how](00-process.md#revisions)). The site lists them here, newest first, and derives the Revision and Updated rows from them.
