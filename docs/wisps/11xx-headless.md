# WISP 11xx: Headless Runtime and Local Control API

| Field | Value |
|---|---|
| Number assignment | 11xx; planned, number to be defined |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-26 |
| Document kind | Contract (local API; nothing here goes on the wire between peers) |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [04](04-profiles.md), [400](400-chat.md), [401](401-paired-chat.md), [100](100-transports.md), [200](200-payments.md), [900](900-group-sessions.md) |
| Implementation | Experimental: `packages/cli` (`@ghostly/cli`, command `ghostly`), phase 1 on `dev` |

> This is a review draft. Candidate numbers are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md).

## Purpose

Bots talk through chats the way the Hermes agent does on Telegram: a process that stays online, reads what arrives, answers, pays and gets paid. For that, everything the app does has to be reachable without a screen. This document fixes how Ghostly runs headless (the **runtime**), how other programs on the same machine drive it (the **local control API**), and what it tells them (the **event stream**). It changes nothing between peers: a headless Ghostly is, to its contacts, one more client of [400](400-chat.md) and [401](401-paired-chat.md).

## Decision: the app's engine on Node

**Chosen.** The headless runtime runs the **same engine as the apps**, `GhostlyNode` from `@ghostly/browser`, compiled into one Node bundle with `@ghostly/core`. It is not a second implementation of the protocol. The web app, the extension and the Desktop are already a UI over the engine's calls (`EngineApi` in `packages/browser/src/shared/rpc.ts`) and its events; the daemon is one more host of that engine (`EngineServer`), and the CLI one more client.

Checked on 2026-09-26 before building: the unmodified engine starts on Node 22, two processes pair through a Pkarr relay, their chat goes live over native HyperDHT in about six seconds, and the Iroh wasm build starts its endpoint.

**Weighed and not chosen.**

| Option | Why not |
|---|---|
| Extend the Rust `ghostly-cli` to v1.0 | Every v1.0 feature (one chat, groups, files/3, eight payment methods, identity providers) lives in TypeScript. A Rust port is a second implementation of all of it, forever behind the app. |
| Drive the Desktop app over a local port | Needs a desktop session and a window; not a server process; one profile per app. |
| A headless browser running the web app | Heavy (a Chromium per bot), no native HyperDHT, and scraping a UI instead of calling the engine. |

## Runtime

| Need | Browser/Desktop today | Headless (Node) |
|---|---|---|
| Storage (IndexedDB) | The browser's IndexedDB | fake-indexeddb for the exact semantics, made durable per profile: a snapshot plus an append-only journal, each committed read-write transaction fsynced before the engine hears `complete` (`packages/cli/src/runtime/storage.ts`). A SQLite-backed store can replace it behind the same module. |
| Files | OPFS (web), native files through Rust (Desktop) | Files under the profile's folder (phase 3) |
| DHT floor, Pkarr | HTTP relays (web); Mainline DHT direct (Desktop, [#289](https://github.com/MiguelMedeiros/ghostly/pull/289)) | HTTP relays, as the web app; DHT-direct is planned (phase 3) |
| HyperDHT ([103](103-hyperdht.md)) | Through a relay (web); a Node sidecar (Desktop) | Native, in process: the Desktop sidecar's own endpoint (`native-transports/hyperdht/endpoint.mjs`) |
| Iroh ([102](102-iroh.md)) | wasm, relay only (web); native (Desktop) | The wasm build, relay only, as the web app ([#225](https://github.com/MiguelMedeiros/ghostly/pull/225)). The native `iroh-peer` bridge is an option later. |
| WebRTC ([101](101-webrtc.md)) | The browser's | None in phase 1 (the chat uses HyperDHT, Iroh or the DHT floor). `node-datachannel` is the candidate; it is a native module, so optional. |
| Calls and screen sharing | WebRTC media | Not applicable: no camera, microphone or screen. Call offers are reported as events only. |

## Profiles and files

- A profile is a folder: `$GHOSTLY_HOME/profiles/<name>/` (default `~/.ghostly`), mode 0700. Its files are 0600.
- It holds the engine's store (`db/`), the daemon's socket (`daemon.sock`), its lock (`daemon.lock`), the event journal (`events.jsonl`) and later received files (`files/`).
- Only one process opens a profile at a time. A command finds the daemon's socket and goes through it; with no daemon it takes the lock, runs the engine for the length of the command and leaves (a **one-shot**). Bots SHOULD run the daemon: a one-shot is offline between commands, so the contact sees it come and go.
- Secrets (seeds, keys, wallet phrases, ecash tokens, backups) are never printed unless the command is given `--show-secret`.

## Local control API

**Transport.** A Unix domain socket at `<profile>/daemon.sock`, created 0600 inside the 0700 profile folder: only the account that owns the profile can connect. There is no TCP listener. On Windows a named pipe takes its place (planned).

**Framing.** Newline-delimited JSON, one object per line, UTF-8, at most 16 MiB per line.

**Requests and responses.**

```json
{"id": 1, "method": "chat.send", "params": {"chat": "afptwgs37ya4m3eg", "text": "hi"}}
{"id": 1, "result": {"messageId": "…", "delivery": "queued"}}
{"id": 2, "error": {"code": "not_found", "message": "No chat afptwgs37ya4m3eg"}}
```

- `id` is chosen by the client (number or string) and echoed.
- Methods are the CLI's own (`status`, `chat.*`, `invite.*`, `events.*`, listed in [the CLI reference](../../packages/cli/README.md)) and **every engine call** as `engine.<method>` with the engine's own parameters (`engine.sendMessage`, `engine.walletCreate`, …). The engine surface is the app's; nothing the app can do is out of reach.
- Error `code`s: `bad_request`, `not_found`, `refused` (the engine declined: a secret in the text, a cross-network payment, a Mainnet spend without confirmation), `unavailable` (not live, no wallet), `engine` (anything else the engine threw), `internal`.

**Mainnet.** Every spend on Mainnet needs the engine's `confirmedReal: true` ([#298](https://github.com/MiguelMedeiros/ghostly/pull/298)); the engine refuses without it. The CLI sets it only when the command is given `--confirm-real`, and its `engine` passthrough strips a `confirmedReal` it was not given that flag for. A program speaking to the socket directly is responsible for the same rule.

**Secrets over the socket.** Calls that return secrets (`engine.exportLinks`, `engine.walletExport`, the wallets' `*Backup`, `*Reveal` and `*ExportBackup`) are answered to the socket, which only the owner can reach; the CLI prints their results only with `--show-secret`.

## Event stream

`events.subscribe` turns the connection into a stream; `ghostly listen` prints it as JSON lines:

```json
{"seq": 42, "id": "message.received:afptwgs37ya4m3eg:1790449803535-3", "type": "message.received", "at": 1790449803601, "chat": "afptwgs37ya4m3eg", "message": {"id": "…", "text": "hello", "timestamp": 1790449803535, "from": "peer"}}
```

- `seq` grows by one per event in a profile, across restarts. `listen --since <seq>` replays what the journal still holds (the last 10,000 events) before following.
- `id` is stable for the fact it reports: the same message received is the same id whenever the daemon derives it again, so a bot that restarts dedupes by `id`.
- Types in phase 1: `daemon.started`, `chat.created`, `chat.removed`, `chat.pairing` (stage changes of the pairing progress), `chat.connection` (live or not, and over what), `message.received`, `message.sent`, `message.delivery` (queued, sent, delivered, failed), `message.deleted`, `group.message`, `call.offer`, `attention`. Later phases add `payment.*`, `file.*`, `identity.*` and `group.*` membership events.
- Hooks: `listen --exec "<command>"` runs the command once per event with the event on its stdin; `listen --webhook <url>` POSTs each event to a local bridge (loopback only).

## Exit codes (CLI)

| Code | Meaning |
|---|---|
| 0 | Done |
| 1 | The engine or the network refused or failed; stdout has `{"error": {...}}` |
| 2 | Usage: unknown command or bad arguments |
| 3 | Not found (profile, chat, message) |
| 4 | Timed out waiting (`--wait`) |
| 5 | Needs confirmation (`--confirm-real`, `--force`) |

## Parity with the app

Status: **Phase 1** (in the first pull request), **Planned (phase n)**, or **Not applicable** with the reason. Every engine call is reachable from the first phase through `ghostly engine <method>`; a phase adds the commands, checks and tests that make the feature usable without knowing the engine.

| Area | Feature | Status |
|---|---|---|
| Profiles | Create, list, use, remove; per-profile folder, files 0600 | Phase 1 |
| Profiles | Name and picture shown to contacts | Phase 1 (`profile set --name`); picture phase 3 |
| Profiles | Backup and restore (WISP 05 bundle) | Planned (phase 3) |
| Invites | Create a `ghostly1` invite and its link; join one; the self-invite guard | Phase 1 |
| Invites | Pairing progress | Phase 1 (`chat.pairing` events) |
| Chats | List, history (paged), send (argument or stdin), stream | Phase 1 |
| Chats | Delivery states, retry, delete, rename | Phase 1 |
| Chats | Transport per chat (auto, webrtc, iroh, hyperdht, dht) and fallback; connection status and history | Phase 1 |
| Chats | Pin and mute | Not applicable: both are UI-only in the app (local display state); a bot filters for itself |
| Chats | Message details | Phase 1 |
| Chats | Secret guard | Phase 1: `send` refuses seeds, keys and ecash unless `--force` (the app's detector) |
| Chats | Rich text | Not applicable: text is text; the bot formats it |
| Chats | Link previews made by the sender | Planned (phase 3, `--preview`) |
| Chats | Hold for an away contact (S3) | Planned (phase 3) |
| Files | Send, receive into a folder, consent for large files (re-asked after expiry, #302), progress events; voice notes as files | Planned (phase 3) |
| Groups | Create, join by link, leave, list, send, history, @mentions in and out | Phase 1 (basic) |
| Groups | Admin: remove, make admin, rotate, link on/off, picture; invite a contact | Planned (phase 3) |
| Payments | Wallet instances per network (the New flow types), list, balance, remove with the #303 protections | Planned (phase 2) |
| Payments | Several Lightning cards, default for receiving | Planned (phase 2) |
| Payments | Testnet faucet | Planned (phase 2) |
| Payments | Pay and request in a chat, accept per chat per network, pay an invoice, LNURL or BIP 21, history | Planned (phase 2) |
| Payments | Mainnet spends only with `--confirm-real`; cross-network refusal | Phase 1 for the passthrough (see Mainnet); commands in phase 2 |
| Identities | Add proofs that need no browser (Nostr with a key or bunker, domain, OpenPGP, SSH, Bitcoin address, DID); list; share per contact; a contact's identities and checks; public profiles | Planned (phase 3) |
| Identities | Proofs that need a browser or an approval app (OpenID, Bluesky, Pubky Ring) | Planned (phase 3): the URL or QR is printed and the command waits; where that cannot work headless, app only |
| Services | Share a loopback web app with a contact; list what a contact shares; open one as a local port | Planned (phase 3) |
| Calls | Voice, video, screen sharing | Not applicable (no media devices); `call.offer` events only |
| Settings | Pkarr relays, Iroh relays, HyperDHT relay, ICE servers; DHT-direct | Phase 1 through `settings set`; DHT-direct planned (phase 3) |

## Wallet SDKs on Node (phase 2 checks)

| Method | SDK | Expected on Node |
|---|---|---|
| Cashu | `@cashu/cashu-ts` | Pure JavaScript and `fetch`: works |
| Lightning sources | LND REST, Core Lightning (Commando over WebSocket), NWC, LNURL, Breez/Spark | LND's pinned certificate needs Node's own TLS options (the Desktop uses a Rust command); WebSocket is global in Node 22; Breez ships a Node build |
| Arkade | `@arkade-os/sdk` | JavaScript; its event streams may need an `EventSource` for Node |
| Bark | `@secondts/bark` (wasm) | The wasm is imported with Vite's `?url`; on Node it must be read from disk |
| Fedimint | web SDK (wasm in a worker, OPFS) | Gap: no OPFS or module worker on Node. Needs the SDK's Node transport or the Rust client |
| Bitcoin (BDK) | `@bitcoindevkit/bdk-wallet-web` (wasm) | As Bark: wasm from disk |
| USDT | `ethers`, WDK | JavaScript: works |

## The Rust `ghostly-cli`

It stays, unchanged, as the **compatibility client** ([402](402-legacy-chat.md)): older DHT records, no `ghostly1` codes, no chat sessions. Its commands and its SKILL.md keep working for the bots that use them. New bots use `ghostly`. The Rust client is marked legacy in the docs; removing it is a separate decision, announced before it happens.

## Security considerations

- The socket is the profile: whoever can open it can spend from its wallets. It is owner-only and never on TCP. A webhook target must be loopback.
- A one-shot command and a daemon never open one profile at once (the lock), so two engines never publish under the same keys or spend the same ecash.
- Events carry message text and payment amounts, never keys or tokens. `--exec` runs the command with the event on stdin, never in its arguments (no shell injection from a contact's text).
- The journal is fsynced per transaction: a crash loses at most a transaction whose `complete` the engine never saw.

## Phases

1. The runtime, the daemon and the API, profiles, invites, one chat (send, receive, stream, transports), basic groups, the event stream and hooks. End-to-end: two CLI peers; a CLI peer and the web app.
2. Wallets and payments on the test networks of the shared regtest stack, with `--confirm-real` on Mainnet.
3. Files, identities, services, advanced groups, settings and DHT-direct.
4. Packaging (npm, then a single binary), the bot skill, examples (echo bot, payment bot), docs.
