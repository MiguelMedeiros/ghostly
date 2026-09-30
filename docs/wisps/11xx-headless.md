# WISP 11xx: Headless Runtime and Local Control API

| Field | Value |
|---|---|
| Number assignment | 11xx; planned, number to be defined |
| Status | Draft |
| Document kind | Contract (local API; nothing here goes on the wire between peers) |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [04](04-profiles.md), [400](400-chat.md), [401](401-paired-chat.md), [100](100-transports.md), [200](200-payments.md), [900](900-group-sessions.md) |
| Implementation | Experimental: `packages/cli` (`@ghostlytools/cli`, command `ghostly`), phases 1 to 5; on npm since 1.0 (`npm install -g @ghostlytools/cli`) |
| Summary | Run Ghostly headless for a bot: a daemon keeps a profile online, a JSON event stream says what arrived, and the ghostly command answers, pays and shares. |
| Availability | Available |
| Notes | Experimental, the same engine as the apps on Node: ghostly1 invites, chats (typing, replies, edits, reactions, forwards), private and community groups, wallets, files and voice notes, identity proofs, shared apps, and voice calls whose audio a program of yours hears and speaks. On npm as @ghostlytools/cli; no Bark wallet, and no video in calls. Pkarr goes to the relays and to the Mainline DHT directly. Number not yet assigned. |

> This is a review draft. Candidate numbers are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md).

## Purpose

Bots talk through chats the way the Hermes agent does on Telegram: a process that stays online, reads what arrives, answers, pays and gets paid. For that, everything the app does has to be reachable without a screen. This document fixes how Ghostly runs headless (the **runtime**), how other programs on the same machine drive it (the **local control API**), and what it tells them (the **event stream**). It changes nothing between peers: a headless Ghostly is, to its contacts, one more client of [400](400-chat.md) and [401](401-paired-chat.md).

## Decision: the app's engine on Node

**Chosen.** The headless runtime runs the **same engine as the apps**, `GhostlyNode` from `@ghostly/browser`, compiled into one Node bundle with `@ghostly/core`. It is not a second implementation of the protocol. The web app, the extension and the Desktop are already a UI over the engine's calls (`EngineApi` in `packages/browser/src/shared/rpc.ts`) and its events; the daemon is one more host of that engine (`EngineServer`), and the CLI one more client.

Checked on 2026-09-26 before building: the unmodified engine starts on Node 22, two processes pair through a Pkarr relay, their chat goes live over native HyperDHT in about six seconds, and the Iroh wasm build starts its endpoint. Building phase 1 found one gap the spike did not: a community group's entry and edge links are WebRTC only in the engine, so WebRTC moved into phase 1 (below). With it, a bot and the web app go live over WebRTC between libdatachannel and Chromium.

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
| Files | OPFS (web), native files through Rust (Desktop) | Real files under the profile's folder (`files/<space>/<id>`, 0600), registered as the engine's `native` backend (`src/runtime/fileBytes.ts`) |
| DHT floor, Pkarr | HTTP relays (web); Mainline DHT direct (Desktop, [#289](https://github.com/MiguelMedeiros/ghostly/pull/289)) | HTTP relays, and the Mainline DHT directly (BEP 44 over UDP): every packet goes to both, reads go to the DHT when every relay fails (`GHOSTLY_DHT=0` turns it off) |
| HyperDHT ([103](103-hyperdht.md)) | Through a relay (web); a Node sidecar (Desktop) | Native, in process: the Desktop sidecar's own endpoint (`native/transports/hyperdht/endpoint.mjs`) |
| Iroh ([102](102-iroh.md)) | wasm, relay only (web); native (Desktop) | The wasm build, relay only, as the web app ([#225](https://github.com/MiguelMedeiros/ghostly/pull/225)). The native `iroh-peer` bridge is an option later. |
| WebRTC ([101](101-webrtc.md)) | The browser's | libdatachannel through `node-datachannel`'s W3C polyfill (a native module with prebuilt binaries). Needed, not optional, for groups: the engine gives group links no native endpoints, so a group without WebRTC never joins. It is also how a bot goes live with a browser directly. Without the module (or with `GHOSTLY_WEBRTC=0`) the CLI still chats over HyperDHT, Iroh and the DHT, and says so. |
| Calls and screen sharing | WebRTC media | Not applicable: no camera, microphone or screen. Call offers are reported as events only. |

## Profiles and files

- A profile is a folder: `$GHOSTLY_HOME/profiles/<name>/` (default `~/.ghostly`), mode 0700. Its files are 0600.
- It holds the engine's store (`db/`), the daemon's socket (`daemon.sock`), its lock (`daemon.lock`), the event journal (`events.jsonl`) and later received files (`files/`).
- Only one process opens a profile at a time. A command finds the daemon's socket and goes through it; with no daemon it takes the lock, runs the engine for the length of the command and leaves (a **one-shot**). Bots SHOULD run the daemon: a one-shot is offline between commands, so the contact sees it come and go.
- A daemon stops cleanly on SIGINT, SIGTERM and SIGHUP (the terminal or SSH session it ran in closing): it tells its contacts it is going, saves its store and removes its socket (#486). `listen` running as the daemon does the same.
- Secrets (seeds, keys, wallet phrases, ecash tokens, backups, group entry links) are never printed unless the command is given `--show-secret` (`group create` and `group link` print a group's link: asking for it is asking for the secret). `chat.created` carries the chat with `invite: null`: a pending invite code goes only to `invite create` and `chat show`, never to a hook (#479).
- A secret a command takes comes on stdin, out of `ps` and the shell's history: `wallet redeem` reads the Cashu token there when none is given, and `wallet create --stdin` reads `name=value` lines (`api-key=…` for an API key). On the command line it still works, with a warning on stderr (#483).

## Local control API

**Transport.** A Unix domain socket at `<profile>/daemon.sock`, created 0600 inside the 0700 profile folder: only the account that owns the profile can connect. The daemon makes the profile folder 0700 again before it listens (a folder opened up is closed; a link, or another user's folder, is refused) and makes the socket under a 077 umask. When that path is longer than a socket path may be (104 bytes on macOS), the socket is `/tmp/ghostly-<hash of the folder>/daemon.sock`, still 0600, in a 0700 folder the daemon refuses when another user made it or may enter it; a client connects only to a socket its own user owns. There is no TCP listener. On Windows a named pipe takes its place (untested).

**Framing.** Newline-delimited JSON, one object per line, UTF-8, at most 16 MiB per line.

**Requests and responses.**

```json
{"id": 1, "method": "chat.send", "params": {"chat": "afptwgs37ya4m3eg", "text": "hi"}}
{"id": 1, "result": {"messageId": "…", "delivery": "queued"}}
{"id": 2, "error": {"code": "not_found", "message": "No chat afptwgs37ya4m3eg"}}
```

- `id` is chosen by the client (number or string) and echoed.
- Methods are the CLI's own (`status`, `profile.*`, `settings.*`, `invite.*`, `chat.*`, `group.*`, `events.*`, `daemon.stop`, listed in [the CLI reference](../../packages/cli/README.md)) and **every engine call** through `engine.call` (`{"method": "walletCreate", "params": {…}, "confirmReal": false}`) with the engine's own parameters. The calls reachable are exactly the app's `EngineApi` (a test keeps the two lists equal) plus the reads `getState` and `getMessages`; nothing else on the engine object is. Nothing the app can do is out of reach.
- Error `code`s: `bad_request`, `usage` (the CLI's arguments), `not_found`, `refused` (the engine declined: a cross-network payment, a text the chat cannot carry, the own invite), `unavailable` (not live, no session), `confirm` (needs `force`, `yes` or `confirmReal`), `timeout` (a wait ran out), `busy` (another process holds the profile), `engine` (anything else the engine threw), `internal`.

**Mainnet.** Every spend on Mainnet needs the engine's `confirmedReal: true` ([#298](https://github.com/MiguelMedeiros/ghostly/pull/298)); the engine refuses without it. The CLI sets it only when the command is given `--confirm-real`. `engine.call` refuses (`confirm`) parameters that carry `confirmedReal` unless the request itself says `"confirmReal": true`, so a `confirmedReal` copied into parameters by mistake moves nothing. A program speaking to the socket directly is responsible for setting it only on a person's explicit confirmation.

**Secrets over the socket.** Calls that return secrets (`exportLinks`, `takeInvite`, `walletExport`, the wallets' `*Backup`, `*Reveal` and `*ExportBackup`, Fedimint notes) are answered to the socket, which only the owner can reach; the CLI refuses to make them without `--show-secret`, and `settings.get` masks credentials unless asked. A group's entry link lets anyone join: `group.get`, `group.list` and the admin methods answer `link: "<hidden>"` unless `showSecret` is set, `group.created` events never carry it, and `engine getState` hides `entryLink`; `group.create` and `group.link` answer with it.

### Typing

`chat.typing` (`ghostly typing <chat> [--kind typing|recording|thinking] [--status "<text>"] [--for <seconds>] [--stop]`) says this side is writing, recording a voice note or thinking, with an optional status line shown in its place on the contact's screen ("Transcribing your audio…"): [401](401-paired-chat.md#typing). A `start` holds 6 s there, so a bot says it again while it works; a new kind or status reaches the contact at once, and a message or `--stop` ends it. The CLI refuses (`bad_request`) an unknown kind, a status over 40 characters, a status with a link or markup (the contact's app would drop it), and a kind or status with `--stop`. The contact's side reports `typing.started` with `kind` (always) and `status` (when given), and again whenever either changes while the typing lasts; `typing.stopped` carries neither.

`group.typing` (`ghostly group typing <group> [--kind …] [--status "<text>"] [--for <seconds>] [--stop]`, revision 2026-09-28) says the same in a private group, on the edges that are up ([Group Mesh § Typing](9xx-group-mesh.md#typing)), with the same checks, and answers with `reached`, the members whose edge is open. A community does not carry typing yet: the command fails with `unavailable`. The other members' side reports `group.typing.started` (`group`, `member`, `kind`, and `status` when given; again when either changes) and `group.typing.stopped` (`group`, `member`), one per member, never `typing.*`, so a bot that follows chats is not woken by a group.

### Status cards

`task.send` (`ghostly task send <chat|group> --title … [--status s] [--progress n | --steps a/b] [--step "…"] [--item state:text]… [--pr-url … --pr-number n --additions n --deletions n --files n] [--branch b] [--link url]… [--id id] [--json json|-|file]`, revision 2026-09-29) sends a task card ([4xx · Status Cards](4xx-status-cards.md)) to a chat or a group; the engine checks the card by the sender's rule and writes its fallback text. A card without an id gets one (`task-…`), a task without a status is `running`, and its `startedAt` is now. In `--item state:text` a lowercase word before the first colon is the item's state and must be `pending`, `running`, `done`, `failed` or `skipped` (another is a usage error that lists them; `pending:fix: x` keeps such a colon in the text); other text, as `Step 2: build` or a link, is a pending item as given. It answers `task` (the id) and `messageId`. `task.update` (`ghostly task update <chat|group> <task> [fields…]`) finds the latest message of this profile with that task's id, merges the fields given over its card (`pr` field by field; `null` in `--json` removes a field) and edits the message. Updates of one card go at most once per **2.5 s**: one that comes sooner merges into the next, which the daemon sends when the time is up (`queued: true`); a one-shot waits the time out itself. `--wait confirmed` (a chat) or `sent` (a group) waits as `edit` and `group edit` do. Out-of-bounds cards are refused with `bad_request`, an unknown task with `not_found`, and an update of a card message that took its 5,000 edits with `refused`, saying to start a new card with `task send`. The app never offers to create cards: only this runtime sends them. Message JSON in history and events carries `card`. `routine.send` and `routine.update` (`ghostly routine send <chat|group> --name … --schedule "every day 01:00" [--cron …] [--state active|paused] [--next <ms or date>] [--run ok|failed|skipped[:summary]]`, `ghostly routine update <chat|group> <routine> [fields…]`, revision 2026-09-29) do the same for a routine: `--run` records a run now as its `lastRun` and the newest of its `runs` (10 kept), and the updates merge and are paced as a task's.

### Message buttons

`send` and `group send` take `--button <id>:<label>` (1 to 6, repeated), `--style <id>=primary|neutral|danger`, `--once` and `--id <id>` (revision 2026-09-30): the message goes with a card of kind `buttons` ([4xx · Message Buttons](4xx-message-buttons.md)), its text being the question. The answer carries `buttons` (the card's id, `ask-…` unless given), `card` and, in a 1:1 chat, `pressable` (the contact's app listed `buttons/1`; null until it says). A press received reports `button.pressed` (`chat` or `group`, `messageId` the question's, `button`, `label`, `by` (the chat, or the member's key in a group) and `name`, `replyId`, and `inferred` when the reply named no button); the reply's own `message.received` or `group.message` is reported too, and an `agent.turn` carries `press`. `button update <chat|group> <message> [--chosen <id>] [--close] [--text "…"] [--force] [--wait …]` edits the question with the card of that version; a closed question stays closed; a new text passes the secret guard as `edit` does (`confirm` unless `--force`), and people see it marked edited. A bot MUST dedupe `button.pressed` by its `id`, and treats `name` as untrusted. Message JSON carries `press` on a reply that pressed this profile's button, and `replyTo.button`.

## Event stream

`events.subscribe` turns the connection into a stream; `ghostly listen` prints it as JSON lines:

```json
{"seq": 42, "id": "message.received:afptwgs37ya4m3eg:1790449803535-3", "type": "message.received", "at": 1790449803601, "chat": "afptwgs37ya4m3eg", "message": {"id": "…", "text": "hello", "timestamp": 1790449803535, "from": "peer"}}
```

- `seq` grows by one per event in a profile, across restarts. `listen --since <seq>` replays what the journal still holds (the last 10,000 events) before following.
- `id` is stable for the fact it reports: the same message received is the same id whenever the daemon derives it again, so a bot that restarts dedupes by `id`.
- Types: `daemon.started`; `chat.created`, `chat.removed`, `chat.renamed`, `chat.pairing` (stage changes of the pairing progress), `chat.connection` (live or not, and over what); `typing.started` and `typing.stopped` (the contact is writing, or stopped, [401](401-paired-chat.md#typing)); `message.reaction` and `group.reaction` (someone, this profile included, reacted to a message or took a reaction back: `messageId`, `by` (`me`, `peer` or a member key), `emoji` ("" when taken back), `removed`, and `mine` when the message is this profile's, [400](400-chat.md#reactions)); `chat.joined` (the contact's app announced itself with its join notice: shown by the apps as a line, so not a `message.received`) and `chat.announced` (this side's); `message.received`, `message.sent`, `message.delivery` (sending, queued, waiting, held, sent, delivered, failed), `message.edited` (a text changed in place, the contact's as it came or mine as made here, once per edit number, with `edits` and the message as it is now, [400](400-chat.md#edits)), `message.deleted`; `group.message.edited` (the same in a group, with `group`); `group.created`, `group.status`, `group.members` (joined, left), `group.typing.started` and `group.typing.stopped` (a member of a private group is writing, or stopped, [Typing](#typing)), `group.message` (the author's member key in `member` and name in `nick`, from the roster when the message came without one; `mentioned` when it names this profile), `group.mentioned` (a mention of this profile learned after its `group.message` said none: a copy another member handed on without it, completed by the author's, or an edit that names the profile; with `group`, `messageId` and the message as it is now; once, restarts included), `group.sent`, `group.event`, `group.deleted`, `group.removed`; `payment.created` and `payment.updated` (a payment or request, in or out, and its state); `call.incoming`, `call.outgoing`, `call.connected`, `call.ended` ([Calls](#calls)); `events.gap` (a replay asked for more than the journal keeps). `file.offered`, `file.stage`, `file.done`, `file.failed` (transfers, by file id, each with its `chat` and the `messageId` of the message that carries the file; an event whose message is not stored yet waits for it up to 2 s, then goes with `messageId: null`). `chat.held` and `chat.released` (a [hold](#staying-off-the-direct-link) began or ended).
- A file message carries its file on `message.received` and `message.sent`: `message.file` is `{id, name, size, mime, voice?, image?}`, a voice note's `voice` is `{duration, peaks?}` (milliseconds, the 0-255 bars), and a picture's `image` is `{width, height}`, its size as shown when its sender sent one. Before [#358](https://github.com/MiguelMedeiros/ghostly/pull/358) it was `voice: true`; the value is still truthy for a bot that tests it. `identity.received`, `identity.status`, `identity.approval`, `identity.progress`.
- Which messages were reported is kept in the profile's own store (a database of the CLI's beside the engine's): a restart reports only what is new, a message that arrived while no process derived events (a crash) is reported at the next start, and a profile's first start reports none of the history it already had.
- As the app's chat screen does, the side that joined says `👋 <name> joined` once the chat first goes live and the other side answers once; each is said once per chat, across restarts.
- Hooks: `listen --exec "<command>"` runs the command once per event, in order, with the event on its stdin; `listen --webhook <url>` POSTs each event to a local bridge (loopback only); `listen --cursor <file>` records the last event handled (the acknowledgement), and a restarted listener resumes after it. A step that fails on one event (the output, the allowlist's lookup, the cursor file) is said on stderr and that event is passed; the ones after it are still handled. With no daemon running, `listen` becomes the daemon, socket included, so a hook can answer with `ghostly send`.
- Agent turns (#431): `listen --from <chat|key>` and `--group <group>` (each repeatable) are an allowlist per listener, not profile state: any other chat's or group's event never reaches `--exec`, `--webhook` or stdout, and the cursor moves past it. `listen --turns` gives one `agent.turn` event per message received and per group message that mentions the profile (from `group.mentioned` when the mention was learned later), with the source event's `seq`, a stable `id` (`agent.turn:<source id>`), the chat or group and member, the `messageId` to reply to, and everything the sender controls (text, name, quoted line, file name) under `untrusted` only. The daemon's socket gives every event (`events.subscribe`) with no allowlist yet.

### Staying off the direct link

`chat disconnect <chat>` closes the live session, and the contact's app redials within seconds. A bot that must stay off the direct link for a while uses `chat disconnect <chat> --hold <minutes>` (up to 10,080): the chat takes its own "DHT only" choice ([400](400-chat.md): either side choosing it keeps both off the live link) and gives it back when the time is up, or on `chat connect`, or on `--hold 0`. The DHT floor still carries short texts; files, calls and typing wait; the contact's app shows the chat as DHT only. The hold is kept in the profile folder (`holds.json`): a restarted daemon takes back a hold whose time is up and times the others again, and never undoes a DHT only the chat had chosen before (that is refused as a hold). `settings online false` is another thing: the whole profile goes offline, DHT included, and nothing arrives.

### Typing kept on

A typing `start` holds 6 s on the contact's side ([401](401-paired-chat.md#typing)). `typing <chat> --for <seconds>` (and `group typing <group> --for <seconds>`, which a message to that group ends) (up to 600) has the daemon say it again, at twice the engine's refresh pace, until the time is up, a message goes to that chat (from any command or `engine` call), or `typing --stop`; when the time is up it says `stop`. A one-shot command stays for that long. It says the `--kind` and `--status` it was given each time ([Typing](#typing)).

### Versions

`status` answers the daemon's `version`. Every command that goes through a daemon asks for it first and, when it differs from the command's own, says so on stderr (the answer on stdout is unchanged). `daemon restart` stops the running daemon and starts the command's own release in the background.

## Exit codes (CLI)

| Code | Meaning |
|---|---|
| 0 | Done |
| 1 | The engine or the network refused or failed; stdout has `{"error": {...}}` |
| 2 | Usage: unknown command or bad arguments |
| 3 | Not found (profile, chat, message) |
| 4 | Timed out waiting (`--wait`, `chat wait`, `file wait`) |
| 5 | Needs confirmation (`--confirm-real`, `--force`) |

## Parity with the app

Status: the **phase** that shipped it (phases 1 to 4 are on `dev`: #323 to #327), **Planned**, or **Not applicable** with the reason. Every engine call is reachable from the first phase through `ghostly engine <method>`; a phase adds the commands, checks and tests that make the feature usable without knowing the engine.

| Area | Feature | Status |
|---|---|---|
| Profiles | Create, list, use, remove; per-profile folder, files 0600 | Phase 1 |
| Profiles | Name and picture shown to contacts | Phase 1 (`profile set --name`), picture phase 3a (a JPEG within the bounds contacts check; no image library on Node to scale one) |
| Profiles | Backup and restore | Phase 3b: the WISP 05 envelope around the headless profile (its store and files); it restores into a new headless profile. The app's backups come from its page's storage and are not interchangeable |
| Invites | Create a `ghostly1` invite and its link; join one; the self-invite guard | Phase 1 |
| Invites | Pairing progress | Phase 1 (`chat.pairing` events, `chat wait`) |
| Invites | Join notices (`👋 <name> joined`) as the app's chat screen sends them | Phase 1 |
| Chats | List, history (paged), send (argument or stdin), stream | Phase 1 |
| Chats | Delivery states, retry, delete, rename | Phase 1 |
| Chats | Edit a sent text in place (a status a bot updates); `message.edited`; `edits` and `editedAt` in history | `ghostly edit <chat> <message> [text \| --text <text> \| --stdin] [--wait confirmed]` (#351) |
| Groups | Edit a text sent to a group in place; `group.message.edited`; `edits` and `editedAt` in group history | `ghostly group edit <group> <message> [text \| --text <text> \| --stdin] [--mention <member>]` |
| Groups | Wait until a group message or edit left: groups have no receipts, so `--wait sent` on `group send` and `group edit` returns once at least one edge took it (a member's in a private group, one of the profile's hubs' in a community), with `edges` in the answer; exit 4 after `--timeout` | `ghostly group send\|edit … --wait sent [--timeout s]` |
| Chats | Transport per chat (auto, webrtc, iroh, hyperdht, dht) and fallback; connection status and history | Phase 1 |
| Chats | Pin and mute | Not applicable: both are UI-only in the app (local display state); a bot filters for itself |
| Chats | Message details | Phase 1 |
| Chats | Reactions: `react <chat> <message> <emoji>` and `--remove`, `group react`, reactions on each message of history, `message.reaction` / `group.reaction` events | #354 |
| Chats | Forwards: `forward <chat\|group> <message>… --to <chat\|group>… [--force] [--wait none\|sent]`, up to 5 targets, files from the stored bytes; `forwarded` (the hop count) on each message of history and events | #404 |
| Chats | Typing indicator: typing, recording, thinking and a bot's status line ([Typing](#typing)) | Phase 1 (typing), kinds and status with 401 0.11 |
| Chats | Secret guard | Phase 1: `send` refuses seeds, keys and ecash unless `--force` (the app's detector) |
| Chats | Rich text | Not applicable: text is text; the bot formats it |
| Chats | Wake-up push ([401](401-paired-chat.md#wake-up-push)): a contact's closed web app that shared a push subscription is woken when a message to it cannot go live; the CLI posts from Node, which has no CORS to get past. It is never woken itself: a daemon stays online | #394 |
| Chats | Link previews made by the sender | Planned (not in phases 1 to 4; `--preview`) |
| Chats | Hold for an away contact (S3) | Planned (not in phases 1 to 4) |
| Files | Send, save to a folder, consent for files over 25 MiB (files/3; the engine re-asks after expiry, #302), pause, resume, cancel, events naming their message; `file wait` and `file save --wait`; a file named by its id alone in every file command; a picture (PNG, JPEG, GIF, WebP) goes with its size as shown, read from its first 256 KiB as the apps read it ([501](501-paired-files.md#rules) `image`; none when they do not say), and `file send` answers with it; voice notes (`--voice [ms]`: length and the 64 waveform bars measured from the file with the recorder's meter, `voicePeaksOf`; WAV, Opus and MP3 decoded in wasm, other audio through `ffmpeg` when present); `--reply <message>` quotes a message, as `send --reply` does | Phase 3a |
| Groups | Create (community with its link, or a private mesh), join by link, leave, forget, accept or decline an invitation, list, send, history, @mentions in and out | Phase 1 (needs WebRTC) |
| Groups | For bots: `group send` answers with the message's id (what replies and reactions name); messages name their author (`member`, `nick` from the roster, or the name an author no longer in it had); the entry link is a secret, `<hidden>` unless `--show-secret` or `group link` | #372 |
| Groups | Admin: remove, make admin, rotate, link on/off/reset, picture; invite a contact | Phase 3a |
| Payments | Wallet instances per network (the New flow types), list, balance, remove with the #303 protections | Phase 2 (Bark: app only, see below) |
| Payments | Several Lightning cards, default for receiving | Phase 2 |
| Payments | Testnet faucet | Phase 2 |
| Payments | Pay and request in a chat, accept per chat per network, pay an invoice or a Lightning address/LNURL, history, payment events | Phase 2; BIP 21 and on-chain sends through `engine preparePayment`/`approvePayment` until phase 3 |
| Payments | Mainnet spends only with `--confirm-real`; cross-network refusal | Phase 2: every spending command refuses Mainnet without it (exit 5), and `pay` never infers Mainnet from an invoice (test mints issue `lnbc` invoices) |
| Identities | Add proofs that need no browser (SSH, OpenPGP, Bitcoin address with the tool; domain and DID by a published record; Nostr over NIP-46 and other in-app signers with their fields); list; share and withdraw per contact; a contact's identities, checks and re-checks; public profiles (`settings set publicProfiles`) | Phase 3b |
| Identities | Proofs that need a browser or an approval app | Phase 3b for in-app signers that wait on a link or a code (reported as `identity.approval` events and printed); OpenID Connect (a browser popup) is app only |
| Services | Share a loopback web app with a contact; list what a contact shares; open one as a local port | Phase 3b: loopback only, redirects handed back rather than followed (as the Desktop's Rust fetch), granted per contact. An opened service has a host name of its own, `http://<random>.localhost:<port>/`, and answers no other `Host` (404), so its cookies and storage are apart from every other app on this machine. `service open` gives a link that hands the browser an HttpOnly cookie and goes on to `/`; a request without that cookie gets 404, so someone else on this machine who finds the port cannot use it. The contact's `Set-Cookie` loses its `Domain`, only the cookies that service set go on to the contact, and its answer streams through (32 MiB at most; one cut short ends the response) (#466, #479, #560) |
| Calls | Voice: place, answer, decline, hang up, auto-answer; the audio to and from a program | Phase 5 ([#350](https://github.com/MiguelMedeiros/ghostly/pull/350)), see [Calls](#calls) |
| Calls | Video, screen sharing | Not applicable: a video call is answered as a voice call |
| Settings | Pkarr relays, Iroh relays, HyperDHT relay, ICE servers, public profiles, sharing the profile's name | Phase 1 through `settings set` and `profile set` |
| Settings | DHT-direct (Mainline reached over UDP, as the Desktop) | Available beside the relays (`bittorrent-dht`): the same signed payload goes to relays and DHT; checked on a loopback testnet with relays answering 500 (a group joined by its link, its edge up and a message delivered in 16 s); `GHOSTLY_DHT_BOOTSTRAP` for private testnets |

## Calls

A bot or an agent joins a voice call with the apps: the CLI takes part in [601](601-webrtc-media.md#paired-profile) calls/1 as any app does, and hands the call's audio to an outside program. Nothing about speech is in Ghostly: recognizing it, answering and speaking are the program's.

**Media.** A WebRTC connection of the CLI's own per call, as in the apps: libdatachannel (node-datachannel, the module the CLI's chats use) for ICE, DTLS-SRTP and RTP, and libopus built to WebAssembly (`opusscript`) for Opus. Nothing changes on the wire: the same compact signals on the chat session, the SDP rebuilt around them (`buildSdpFromSignal`). Choices of a side that runs no browser:

- **Voice only.** Its offer has an audio section alone (the contact's app answers it, and its video lane stays closed). A contact's offer has a video section too: it is answered, and whatever comes on it is dropped. A video call rings as `video: true` and is answered as a voice call.
- **Candidates.** A signal on the chat session may carry eight; a headless host often has several interfaces (Docker, VPNs, Tailscale) of which the first is not the one the contact reaches. So a CLI signal carries every IPv4 host candidate first, then the server reflexive one, then IPv6 hosts, without their related addresses.
- **Availability.** The CLI offers `calls/1` only when node-datachannel and Opus load (not with `GHOSTLY_WEBRTC=0`); otherwise its contacts' call buttons say why.

**Audio contract.** One Unix socket per call, 0600, in the profile's folder (`calls/<call>.sock`, or `/tmp/ghostly-calls-<hash>/<call>.sock` when the path is too long for a socket, in a 0700 folder the CLI refuses when another user made it or may enter it). It exists from the moment the call is placed or answered.

| | |
|---|---|
| Format | Raw PCM, no framing: signed 16-bit little-endian, mono, at the call's rate: 48000 by default, or 24000, 16000, 12000, 8000 (`--rate`). Opus runs at that rate itself: nothing is resampled |
| From the call | The contact's audio, in 20 ms frames, as soon as each is decoded. A late packet waits up to 40 ms; a lost one is 20 ms of silence |
| To the call | Any amount at any time. The CLI queues it (at most five minutes), sends a 20 ms frame per tick at real time, and silence when the queue is empty. A partial frame waits 60 ms for the rest, then plays padded |
| Barge-in | `call.flush` drops everything queued at once and says how much (`flushedMs`) |
| Programs | One at a time: a new connection replaces the old one, which reads EOF |
| End | The program reads EOF and the socket is removed; `call.ended` says why |
| Latency added | At most one 20 ms frame going out; coming in, none beyond decoding (and the wait for a late packet) |

**Commands and methods.** `call start <chat>`, `call answer [<chat|call>]`, `call hangup [<chat|call>]` (declines a call that rings), `call list`, `call flush`, `call auto on|off [--from <chat>]…` (kept in the profile's `calls.json`), and `call pipe` (the audio on stdin and stdout); on the socket, `call.start|answer|hangup|list|get|flush|auto`. Calls need the daemon: a one-shot command still reports a call that rings, and refuses to place or answer one.

**Events.** `call.incoming` `{call, chat, name, video, auto}`, `call.outgoing` `{call, chat, name, audio}`, `call.connected` `{call, chat, direction, audio: {socket, rate, channels, format, frameMs}}`, `call.ended` `{call, chat, direction, reason, duration?}`. `reason` is `hangup` (this side hung up, or declined), `remote-hangup` (the contact hung up a connected call), `missed` (an incoming call stopped ringing unanswered), `rejected` (the contact declined), `unanswered` (this side's call rang 60 s), `crossed` (both called at once and the contact's call came first; it rings here next), `failed` (the media did not connect within 30 s, or dropped, or the contact's app hung up saying it could not connect, `r: "u"`) or `stopped` (the daemon stopped, and hung its calls up first).

**Rules**, the apps' (`useWebRTC`): one call per chat; an offer rings only while that chat has none, or when it wins a glare with this side's own ([601](601-webrtc-media.md), "Both call at once"); an answer counts only after this side's offer; a hang-up ends whatever is on; a signal no newer than the last one handled is ignored; after a hang-up the signal is cleared 5 s later. The contact's app closes its connection as it hangs up, often before its hang-up signal arrives over the chat session: a call whose media closed waits 3 s for that signal, and without one a connection the contact closed still counts as its hang-up.

**Diagnostics.** The daemon's log has, per call, the candidates each side offered, every ICE state and the pair it connected over; `call list` shows the ICE state and the pair (`stats.ice`). WebKit's candidates are mDNS names that often resolve nowhere: a call with the macOS app then connects only when the app's checks reach the CLI, which a VPN as the default route on the same Mac prevents (the app sends from the tunnel's address).

**Evidence.** Unit tests (the queue, RTP, the socket, Opus at 48 and 16 kHz), two call managers over libdatachannel on loopback, two daemons calling each other (`test/twoPeers.test.ts`, with the `call-echo` example), and the web app calling a bot and the bot calling back with a tone each way (`e2e/web/headless-call.spec.ts`, Chromium). A probe also connected Playwright's WebKit (WPE, Linux) to the CLI, with audio both ways. The macOS app (WKWebView) calling the CLI is not tested yet.

## Wallet SDKs on Node (phase 2)

Checked on 2026-09-26 by creating each Testnet wallet in a headless profile:

| Method | SDK | On Node |
|---|---|---|
| Cashu | `@cashu/cashu-ts` | Works as is |
| USDT | `ethers`, WDK | Works as is |
| Arkade | `@arkade-os/sdk` | Works. Its descriptor library is CommonJS and `require`s the ESM `@scure/bip32`; loaded while the engine's imports were still evaluating it, it saw no `HDKey`, so the runtime loads both first. Its server events need `EventSource`, which Node lacks: the `eventsource` package provides it |
| Spark (Breez) | `@breeztech/breez-sdk-spark` web build | Works. Its storage checks `window.indexedDB` (Node has no `window`, and defining one would turn other libraries onto their browser paths): the build rewrites that one check to `indexedDB` and fails if a Breez release changes it. Its wasm is copied beside the bundle |
| Bitcoin (BDK) | `@bitcoindevkit/bdk-wallet-web` (wasm) | Works: `?url` assets become `file:` URLs beside the chunk that imports them, and the runtime's `fetch` reads `file:` URLs of `.wasm` files only. The CLI draws the recovery phrase the app's form would |
| Lightning sources | NWC, LND REST, Core Lightning (Commando), Breez, LNURL | They load as in the web app (WebSocket and `fetch`); only the Cashu mints' card was exercised end to end so far. An LND behind a self-signed certificate is untested (the Desktop pins it through Rust) |
| Bark | `@secondts/bark` (browser build only) | **Gap.** Its Rust storage insists on a browser `window`; pretending one gets further, then the wasm panics and takes the process down. App only until Bark ships a Node build |
| Fedimint | web SDK (`@fedimint/core`, its wasm in a worker, a database per federation on OPFS) | Works, on a platform of the CLI's own (below). Checked on the shared stack's regtest federation: preview, join, Lightning in and out through its gateway, balance, restart |

**Fedimint on Node.** The client's wasm reads and writes its database through a sync access handle, and calls only `read` and `write` (each with `{ at }`), `getSize`, `truncate`, `flush` and `close` on it; its network is `fetch` and `WebSocket`, which Node 22 has. So the CLI runs the app's SDK and wasm unchanged: each database in a `worker_threads` worker (`packages/cli/src/runtime/fedimintWorker.mjs`, the browser worker's protocol) on a file of the profile, `fedimint/ghostly-fedimint-<id>.db`, through a small `node:fs` handle, with `CloseEvent` (missing on Node 22) given in the worker. The engine takes it through its `fedimintSdk` option; `fedimintSdk.ts` takes its worker and files from a `FedimintPlatform`, and the browser's is the code it ran before. The profile's lock keeps a second process off its databases, as the exclusive handle does in a browser.

No wallet is made by itself on Node (`automaticWallets` is off): a bot has only the wallets it created, and none on Mainnet unless asked.

## The older Rust `ghostly-cli`

It was not the npm package `@ghostlytools/cli`. It was the compatibility client for the older DHT records ([402](402-legacy-chat.md)): no `ghostly1` codes, no chat sessions. The release stopped shipping it at 1.0, and its source was removed after 1.0. `ghostly` is the CLI.

## Security considerations

- The socket is the profile: whoever can open it can spend from its wallets. It is owner-only and never on TCP. A webhook target must be loopback.
- A one-shot command and a daemon never open one profile at once (the lock), so two engines never publish under the same keys or spend the same ecash.
- Events carry message text and payment amounts, never keys or tokens. `--exec` runs the command with the event on stdin, never in its arguments (no shell injection from a contact's text).
- The journal is fsynced per transaction: a crash loses at most a transaction whose `complete` the engine never saw.

## Phases

1. The runtime, the daemon and the API, profiles, invites, one chat (send, receive, stream, transports), basic groups, the event stream and hooks. End-to-end: two CLI peers; a CLI peer and the web app.
2. Wallets and payments on the test networks of the shared regtest stack, with `--confirm-real` on Mainnet.
3. Files, identities, services, advanced groups, pictures, backups; later the Mainline DHT beside the relays.
4. Packaging: an npm package whose dependencies are exactly what the bundle imports (a test keeps them so), checked by installing the packed tarball outside the repository and running two bots and four wallets from it; the bot skill; examples (echo bot, payment bot). A single-file binary remains open.
5. Voice calls with the apps, the audio handed to a program over a Unix socket per call ([Calls](#calls)); the `call-echo` example.

## Revision log

One file per change in [changes/11xx-headless/](changes/11xx-headless/) ([how](00-process.md#revisions)). The site lists them here, newest first, and derives the Revision and Updated rows from them.
