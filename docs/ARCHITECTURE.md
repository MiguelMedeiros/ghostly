# Architecture

> Ghost is the small rendezvous and record-exchange primitive; Ghostly is its reference application. Chat, voice, video and local web applications compose on top. Live endpoints depend on online peers, while local history and keys can persist.

The [WISP catalogue](wisps/README.md) and [composable map](wisps/MAP.md) describe proposed modular boundaries and groups. Draft status alone does not establish implementation. The subsequent [native transport increment](wisps/TRANSPORT-INCREMENT.md) implements bounded paired text chat over Iroh and HyperDHT; group security remains proposed.

## Repository

| Path | What |
|---|---|
| [`packages/core`](../packages/core) | The Ghost protocol in platform-neutral TypeScript: identities, crypto, Pkarr records, service advertisements, WebRTC signaling, DataChannel framing, HTTP over the data link. Shared by every client. |
| [`packages/react`](../packages/react) | React hooks shared by the clients (`useWebRTC`). |
| [`src`](../src), [`src-tauri`](../src-tauri) | The UI every client builds, and Ghostly Desktop (Tauri): the same peer in a WebView, with Rust reaching the Mainline DHT directly, fetching shared local apps and hosting viewer windows. |
| [`packages/browser`](../packages/browser) | The Ghostly peer, in TypeScript, for anything with a WebView or a browser: engine, ecash wallet, IndexedDB, and the platform layer under the shared UI. |
| [`web`](../web) | Ghostly on the web: that peer in a tab, nothing to install. `docker compose up` serves it. See [WEB.md](WEB.md). |
| [`extension`](../extension) | Ghostly Browser (Chromium, Manifest V3). Builds the same UI as Desktop (`src/`) on top of a background peer, and reaches the DHT through Pkarr relays. See [BROWSER.md](BROWSER.md). |
| [`cli`](../cli) | Rust CLI and library for bots. |
| [`website`](../website) | ghostly.tools |

The wire format is specified in [PROTOCOL.md](PROTOCOL.md).

## Layers

```
 services      chat · voice · video · http · …
 data link     WebRTC DataChannel "ghostly/1", peer to peer, DTLS
 discovery     Pkarr signed packets in the Mainline DHT (directly, or through relays)
 identity      one Ed25519 keypair per link + a shared secretbox key
```

Pkarr records carry discovery, signaling and small encrypted messages. Once available, WebRTC carries live chat and heavy application traffic. Pkarr relays bridge records to the DHT; STUN assists connectivity and optional TURN relays encrypted traffic. These systems can observe metadata. There is no required central Ghostly message server, and the DHT is not a durable history store.

## How It Works

Ghostly uses a clever combination of cryptography and the decentralized web:

| Step | What Happens |
|------|--------------|
| **1. Create Chat** | Generate Ed25519 keypairs + 256-bit symmetric key. No server involved! |
| **2. Share Invite** | URL contains seed + peer pubkey + encryption key. Fragment never leaves the app! |
| **3. Messages Travel** | Small records: encrypt → sign → Pkarr/DHT. Live/bulk traffic: authenticated WebRTC data link |
| **4. Messages Expire** | Stop republishing → availability eventually expires; retained copies and local history may remain. |

## Tech Stack

- **[Pkarr](https://github.com/pubky/pkarr)** - Public Key Addressable Resource Records
- **[Mainline DHT](https://www.bittorrent.org/beps/bep_0005.html)** - Distributed lookup used for Pkarr rendezvous
- **NaCl Secretbox** - XSalsa20-Poly1305 authenticated encryption
- **Ed25519** - Digital signatures for message authenticity
- **BEP44** - BitTorrent DHT mutable items specification

## Small-record message flow (live/bulk traffic uses WebRTC)

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Sender    │     │  Mainline   │     │  Receiver   │
│   Device    │────▶│     DHT     │────▶│   Device    │
└─────────────┘     │  (rendezvous)│     └─────────────┘
                    └─────────────┘
```

1. **Encryption**: Message is encrypted with XSalsa20-Poly1305 using shared key
2. **Signing**: Encrypted payload is signed with Ed25519 private key
3. **Publishing**: Signed data is published to DHT as BEP44 mutable item
4. **Resolution**: Receiver queries DHT using sender's public key
5. **Verification**: Signature is verified with sender's public key
6. **Decryption**: Message is decrypted with shared symmetric key

## Security Model

- **End-to-End Encryption**: Only participants with the shared key can read messages
- **No required central Ghost message server**: network infrastructure still has availability and metadata tradeoffs.
- **Ephemeral network presence**: record TTL is not proof of deletion; local history persists.
- **Scoped keys, not automatic forward secrecy**: a compromised link secret can decrypt retained records encrypted under it.
- **No anonymity guarantee**: keys are per link, but timing, addresses and external proofs may correlate activity.

See the [source evidence and platform matrix](wisps/IMPLEMENTATION.md) for current limitations.
