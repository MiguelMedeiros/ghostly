# Architecture

Ghost is the small rendezvous and record-exchange primitive; Ghostly is its reference application. Chat, calls, files, payments and shared local web apps compose on top. Live connections exist while peers are online; local history and keys persist on each device.

The [WISP catalogue](wisps/README.md) and [composable map](wisps/MAP.md) describe the modular boundaries. The wire format is in [PROTOCOL.md](PROTOCOL.md), and how bytes travel is in [TRANSPORTS.md](TRANSPORTS.md).

## At a glance

```
 Alice                    Mainline DHT (Pkarr)                     Bob
   │── signed, encrypted record ──▶  rendezvous  ◀── signed, encrypted record ──│
   │◀══════════ live link: WebRTC · Iroh · HyperDHT (end-to-end encrypted) ═════▶│
   │               no live path? short texts keep going over the DHT            │
```

- **Two people meet on the public Mainline DHT** (Pkarr records), then talk directly over WebRTC, Iroh or HyperDHT. If no direct path works, short texts keep flowing over the DHT itself ([the one chat](#the-one-chat)).
- **Keys:** a fresh key pair per chat, so no key ties your chats together.
- **Relays are helpers**, not servers that hold your chats. Desktop reads the DHT directly; a browser cannot, so the web app and the extension go through public Pkarr relays. A relay that misbehaves is skipped for a while ([circuit breaker per relay](TRANSPORTS.md#circuit-breaker-per-relay)).
- **Local first:** history, keys and wallets live on the device, optionally behind a password. There is no Ghostly message server and no account ([where state lives](#where-state-lives)).
- **End to end:** relays and DHT nodes see ciphertext, timing and IP addresses, never what you say ([security model](#security-model)).

## Repository

| Path | What |
|---|---|
| [`packages/core`](../packages/core) | The protocol in platform-neutral TypeScript: identities, crypto, invites, Pkarr records and relays, DHT delivery, the chat session and its capabilities, transport negotiation, files, payments, groups, identity proofs. Shared by every app |
| [`packages/browser`](../packages/browser) | The Ghostly peer (`GhostlyNode`): engine, wallets, identities, IndexedDB and file storage, and the platform stand-ins the shared UI is built with. Runs in the web app, the extension and Desktop |
| [`packages/react`](../packages/react) | React hooks shared by the apps (`useWebRTC`) |
| [`packages/sdk`](../packages/sdk) | `@ghostly/sdk`: adapter contracts, fakes, contract suites, the plugin registry and the protocol library. See [SDK.md](SDK.md) |
| [`packages/iroh-web`](../packages/iroh-web) | Iroh compiled to wasm (`@ghostly/iroh-web`), built from `native-transports/iroh-web` |
| [`src`](../src) | The UI every app builds (React). `src/desktop` holds Desktop's host |
| [`src-tauri`](../src-tauri) | Ghostly Desktop (Tauri 2): Rust for the Mainline DHT, native Iroh, the HyperDHT sidecar, local app fetches, viewer windows, notifications |
| [`web`](../web) | The web app: the peer in a tab. See [WEB.md](WEB.md) |
| [`extension`](../extension) | Ghostly Browser (Chromium, Manifest V3): the peer in an offscreen document. See [BROWSER.md](BROWSER.md) |
| [`cli`](../cli) | `ghostly-cli`, a Rust compatibility client and library for bots. See [CLI.md](CLI.md) |
| [`native-transports`](../native-transports) | Native Iroh (Rust), the HyperDHT endpoint and sidecar (Node), the HyperDHT relay for browsers, and the Iroh wasm crate |
| [`website`](../website) | ghostly.tools |
| [`e2e`](../e2e) | End-to-end tests. See [TESTING.md](TESTING.md) |
| [`examples/sdk-adapter`](../examples/sdk-adapter) | A complete SDK adapter project |

One peer, three hosts: the web app, the extension and Desktop all build `src/` with the same Vite plugin (`packages/browser/vite-plugin.ts`), which swaps the platform modules for ones backed by the peer. A host (`packages/browser/src/host.ts`) is the small part that differs.

## Layers

```
 services     chat · calls · files · payments · shared apps · groups
 session      chat session (paired-chat/1): pinned keys, capabilities, ordered frames
 layer 1      WebRTC · Iroh · HyperDHT        (a stream, when one connects)
 layer 0      Pkarr records on the Mainline DHT (rendezvous, signaling, DHT text)
 identity     per-chat rendezvous keys + a participation key per side
```

## The one chat

Every 1:1 chat is the same kind of chat ([WISP 400](wisps/400-chat.md)):

1. **Invite.** One `ghostly1…` bech32m code, or the link `https://ghostly.tools/#ghostly1…` ([WISP 801](wisps/801-invitation-profiles.md)).
2. **Rendezvous on the DHT.** Both sides publish and read signed Pkarr records. First contact runs on the DHT and on a stream at once; whichever verifies first pins the contact's participation key.
3. **Upgrade.** The apps rank the transports they share and dial: WebRTC, Iroh or HyperDHT. The first authenticated session makes the chat `live`.
4. **DHT floor.** With no stream, the chat is `on-dht`: text up to 256 bytes goes over the DHT ([WISP 403](wisps/403-dht-text.md)), longer items wait or are held ([WISP 4xx](wisps/4xx-store-and-forward.md)), and the stream is retried in the background for as long as the app runs.
5. **DHT only.** Either side can choose it per chat in the connection panel. Both then stay off streams.

Chats made by Ghostly 0.4 are **compatibility chats** ([WISP 402](wisps/402-legacy-chat.md)): they keep their original record profile and offer "Continue in a new chat".

Groups run on top of 1:1 sessions: private groups up to 8 members ([group mesh](wisps/9xx-group-mesh.md)) and communities up to 256 ([group community](wisps/9xx-group-community.md)).

## Where state lives

| What | Where |
|---|---|
| Chats, keys, messages, settings | The device: IndexedDB (web, extension) or the WebView's storage (Desktop). Never published |
| Files | Origin-private file system in browsers, real files on Desktop |
| Presence, signals, capability records, DHT text | Pkarr records, short-lived, republished while the app runs |
| Held items (optional) | The sender's own S3-compatible storage ([WISP 4xx](wisps/4xx-store-and-forward.md)) |

There is no Ghostly server in the message path. The DHT is not a durable history store.

## Security model

- **End to end.** Records are sealed and signed; streams are authenticated and encrypted (DTLS, QUIC/TLS, Noise). Relays, DHT nodes, STUN and TURN see ciphertext and metadata, never content.
- **Pinned keys.** The invite pins the inviter's participation key. A different key on a stream is a security rejection that stops the chat on both layers, never a fallback.
- **Invites are bearer secrets.** Anyone holding a copy can compete for first contact. Share them privately; comparing the displayed code confirms the pin.
- **No forward secrecy.** A leaked link secret can decrypt records it sealed.
- **No anonymity.** Keys are per chat, but addresses, timing and relays can correlate activity ([what observers see](TRANSPORTS.md#what-observers-see)).
- **Expiry is not deletion.** Records expire from the network; contacts, observers and local history may keep copies.
- **Real money is asked for.** Mainnet spends need an explicit confirmation; wallet secrets are sealed with a device key.

Reporting a flaw: [SECURITY.md](../SECURITY.md). Past audit fixes: [Security review](SECURITY-REVIEW.md). Source evidence and limits per platform: [wisps/IMPLEMENTATION.md](wisps/IMPLEMENTATION.md).
