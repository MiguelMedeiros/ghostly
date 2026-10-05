# WISP 06: One Profile on Several Devices

| Field | Value |
|---|---|
| Candidate number | 06; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [01](01-ghost-core.md), [02](02-peer-keys.md), [03](03-capabilities.md), [04](04-profiles.md), [05](05-backups.md), [200](200-payments.md), [400](400-chat.md), [401](401-paired-chat.md), [403](403-dht-text.md), [404 store-and-forward](404-store-and-forward.md), [501](501-paired-files.md), [800](800-invite-join.md), [900](900-group-sessions.md), [1000](1000-storage.md), [1002](1002-s3-storage.md), [1100](1100-headless.md) |
| Implementation | Phase 1, all 10 parts, on `dev` since #1118 (#1115 to #1162, with follow-ups): the device state and the gate, the turn record, device signing keys and derived device links, enrollment (`enroll/1`, invite version 2), the handoff (`handoff/1`), the forced takeover and the restore guard, removal and a new device secret, wallets in a handoff, push and the phone, and the screens. Web, extension and Desktop (macOS, Windows, Linux); CLI profiles stay `single`. `DB_VERSION` 13. Unit, engine and end-to-end tests (`e2e/web/devices-*.spec.ts`); no Mainnet wallet moves yet |
| Summary | Use one profile on a desktop and a phone: one device is active at a time, and one button moves everything to the device in your hand. |
| Availability | Available |
| Notes | Web, desktop and extension, up to 4 devices. Both devices must be online, with Ghostly open, for a move. Mainnet money keeps the profile where it is for now, and Ark, Bark, Fedimint, USDT and Bitcoin Core stay on the device they were made on. On iPhone and iPad, add Ghostly to the Home Screen first. Two devices live at once, server accounts and background sync are out of scope. |

> This is a review draft. Candidate numbers and new record formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md) and [implementation evidence](IMPLEMENTATION.md).

Number note: legacy reader paths once used `06` for WebRTC (now [101](101-webrtc.md)). Per the [numbering map](NUMBERING.md), the current number takes precedence, as for [04](04-profiles.md) and [05](05-backups.md).

## Purpose

A person wants the same Ghostly profile on the desktop at home and on the phone when away: the same chats, groups, identities and wallets, and a way to say "I am using this one now". Today the only way to get a profile onto a second device is to restore a backup there ([05](05-backups.md)), which makes two live copies of the same keys and the same money. [05](05-backups.md) warns about it ("Treat a bundle as a move"), [02](02-peer-keys.md) lists "multi-device policy" as open, and [1000](1000-storage.md) asks whether "sync between one person's devices" belongs to storage. This document answers with the smallest model that is safe:

- a profile can be **enrolled** on several devices;
- exactly one of them is **active**; the others are on **standby** and do nothing for that profile except talk to the person's other devices;
- a **handoff** moves the whole state to another device and makes it the active one;
- a counter, the **turn**, tells every device which one is active, so a device that was replaced stops.

## Goals and non-goals

In scope:

- The same profile on a desktop app, a web app, an extension and a phone (the installed web app), switched when the person asks.
- Everything comes along: chats, messages, files, groups, identities, settings and, wallet by wallet, money.
- A device that is lost can be taken out, and a remaining device can take over.
- Contacts see nothing new: no new frame, no new record of theirs, no "new device" notice.

Out of scope, on purpose:

- **Two devices live at once** (true multi-device). See [Why not two live devices](#why-not-two-live-devices).
- **A server-side account.** There is no Ghostly server; the only shared places are the DHT and the person's own storage.
- **Automatic background sync.** State moves when the person presses a button, never by itself.
- **Merging two histories.** State has one writer at a time, so a handoff copies; it never merges.
- **CLI profiles.** A profile of the headless CLI ([1100](1100-headless.md)) is always `single`: its stored payload is not the app's, and a bot is its own profile and a contact. A bot moves servers with `profile backup` and `profile restore`, as today.

## What exists today (evidence)

The design rests on these facts of the code on `dev`, each checked against the file it names. Where one is wrong, the section that cites it must change.

| Fact | Where |
|---|---|
| There is no profile-wide key and no device identity. Every chat has its own rendezvous seed, invite secret and participation seed, and a seed per native transport. The only profile-wide key is the DID key, which no chat uses and no contact reads routinely | `packages/browser/src/shared/types.ts` (`StoredLink`), [310 did:dht](310-did-dht.md#the-key), `packages/browser/src/engine/did.ts` |
| Every Pkarr packet of a chat is signed with a sequence number that is the wall clock in microseconds, nothing persisted: with two publishers the last one wins | `packages/core/src/pkarr.ts` |
| Inside the packets there are persisted counters: the DHT mailbox `sequence` and `peerSequence`, the capability record `rev`, the hold pointer `pointerRev`, `outSeq`, `inSeq`, `peerAck`. A reader drops anything at or under its high-water mark, silently | `packages/core/src/dhtDelivery.ts`, `capsRecord.ts`, `packages/browser/src/engine/hold.ts` |
| A group member's send counter starts again at 0 at every epoch change (mesh) and every new head (community), and a frame is accepted once per (sender, epoch, sequence). The message id is `<sender>:<epoch>:<seq>` | `packages/core/src/groupSession.ts`, `groupCommunity.ts` |
| A mesh admin commits by itself when a member leaves, and a community door admits by itself. `commit()` signs from the head in memory. Two commits after one parent fork the group, and a forked group halts | `groupSession.ts` (the `group-bye` handler, `fork()`), `groupCommunity.ts`, `packages/browser/src/engine/community.ts` |
| There is no ratchet and no app-layer session key. All sealing uses random 24-byte nonces, so old state never causes nonce reuse | `packages/core/src/pairedSession.ts`, `crypto.ts`, `groupCrypto.ts`, [02](02-peer-keys.md) |
| A dial-in from the pinned contact while a session is held replaces that session (an app that restarted). Two instances with the same keys running at once make the contact refuse one as crossed | `packages/core/src/ghostlink.ts` (`attachReplacement`), `apps/desktop/src/single_instance.rs` |
| The only guards against two copies are local to one machine: the `ghostly-peer` Web Lock, the extension's offscreen document, the Desktop single instance (Linux only), the CLI's `daemon.lock` | `packages/browser/src/inPageHost.ts`, `packages/cli/src/profiles.ts` |
| The engine starts before the lock screen is passed, and the extension starts it at browser start with no page. `start()` starts identities and the DID, then every wallet, then loads chats | `apps/web/src/main.tsx`, `apps/extension/src/background.ts`, `packages/browser/src/engine/node.ts` (`start()`) |
| The lock password encrypts nothing. It is a screen gate with a PBKDF2-SHA256 verifier (600,000 rounds) in local storage, 4 characters at least, and the verifier travels in backups | `apps/ui/src/Root.tsx`, `apps/ui/src/lib/settings.ts`, `apps/ui/src/pages/Settings.tsx` |
| Keys are seeds in the database and in local storage, signed with a JavaScript library. Nothing uses an OS keychain | `packages/core/src/identity.ts`, `apps/desktop` |
| No database write asks for strict durability | whole repository (no `durability` option anywhere) |
| A backup carries the whole peer database and local keys, files up to 16 MiB, each Ark database; it leaves out the Bark databases, the Fedimint client files, the Breez database, the storage credentials and the push subscription. A restore marks unfinished payment intents `unknown` and rewrites nothing else. Its envelope version check is strict | `apps/ui/src/lib/profileBackup.ts`, `packages/browser/src/backup/envelope.ts`, [05](05-backups.md) |
| A relay read stops at the first relay that answers; a put succeeds when one relay takes it and, refused with 412, is sent again without a condition. Both default relays belong to one operator. The Desktop's DHT publish passes no compare-and-swap value | `packages/core/src/relay.ts`, `apps/desktop/src/pkarr_network.rs` |
| The push subscription is per browser and per profile; a contact keeps one target per chat and learns it only on a live session | [401](401-paired-chat.md#wake-up-push), `packages/core/src/pairedWake.ts` |
| Nothing asks the browser for persistent storage | whole repository |
| An app that finds a database from a newer version shows "This profile was last used by a newer version of Ghostly." and starts nothing. `DB_VERSION` is 12 in the released 1.0.3 (the `swaps` store of the ecash swaps raised it) and 13 with devices (a version step with no schema change, below) | `apps/ui/src/components/ProfileUnavailable.tsx`, `packages/browser/src/shared/idb.ts` (`DB_VERSION`) |

Four consequences shape everything below.

1. **There is no "profile record" to put the turn in.** The turn needs a key and a record of its own, read by the person's own devices only.
2. **The per-record sequence numbers are no lock.** They are clock time, so a stale device that publishes simply wins. The turn is the only lock.
3. **Moving state breaks no key chain** (nothing ratchets), but **rolling state back is harmful**: a device acting on older counters is dropped silently by contacts, its held items can be settled unread, and an admin doing so can halt a group. The handoff moves counters exactly; the paths that cannot (a forced takeover, a restore) raise them and switch admin work off.
4. **A standby is not silent with today's start order.** The gate has to sit in front of everything `start()` does, on every client.

## Measured, and still to measure

Two reviews ran experiments, and the first two parts of phase 1 were then built and measured on the branch `feat/devices`. The results are used below as facts, with these limits.

| Measured | Result | Limit |
|---|---|---|
| BEP44 puts against a local `mainline` 8.0.0 testnet (6 nodes in the review, 8 when the turn record was built) | A lower sequence is refused (error 302). A put with `cas` is refused on a mismatch (301) and stored on a match. A **different packet at an equal sequence is accepted and replaces the first, with no `cas` and with a matching one**: `cas` does not guard an equal sequence. Sequences up to 2^53 - 1 store and read back; above that a JavaScript reader loses precision; above 2^63 the node drops the put | Local nodes of one implementation. Not the public DHT |
| `pkarr-relay` 2.1.0 on a local testnet | A sequence that is not a clock time: 204, and the same bytes read back. The same bytes again: 204. A lower sequence: 409. **`If-Match` naming another sequence is ignored: 204, and the packet is replaced.** A different packet at an equal sequence: 204 when its encoded bytes compare larger than the held packet's, 409 when smaller. Sequences 2^52 - 1 and 2^63 - 1: 204 both. An item on the DHT that is no signed packet: 404 with the header `pkarr-invalid-signed-packet-seq`. **A GET is answered from the relay's cache** for the packet's TTL; `?policy=NetworkOnly` makes the relay ask the DHT | One relay version, on its own local testnet |
| Both default public relays, three requests to each under a random key | `If-Match` naming another sequence is ignored there too (204). Both know `?policy=NetworkOnly` | Three requests each; nothing else was asked of them |
| The Desktop's `pkarr` crate | Its DHT client hides `put_mutable`, so a put with `cas` needs a Mainline node of the turn's own, beside the crate's | From the crate's source |
| Turn record size | As first specified (JSON, sealed, base64url): 989 bytes for 4 named devices and a release, 11 under the limit, and over it with a name that JSON must escape. As specified now (binary body of 374 bytes, 414 sealed, 552 characters): **a DNS packet of 634 bytes and a relay payload of 706 bytes, the same for 1, 2, 3 and 4 devices** | Measured with the app's own packet builder |
| Start time with the gate in front (web build, 15 cold and 45 warm starts, the two builds alternating) | Peer database opened: 398.5 ms before, 394.9 ms after (cold); 315.7 and 316.0 ms (warm). For a `single` profile the gate is one `indexedDB.databases()` call; the difference is within noise | Chromium, one machine |
| A non-extractable Ed25519 WebCrypto key | Generates, refuses export and wrap, signs after a reload and a browser restart, works in a worker | Chromium 153 and WebKit 26.6 under Playwright. Tauri's WebViews (WKWebView, WebKitGTK, WebView2), Firefox and Safari as an installed app on iOS are unverified |
| `navigator.storage.persist()` | Returned false with no prompt in both headless browsers | Headless; a person cannot force it either way |
| Bark and Fedimint databases | Bark's two are plain IndexedDB; Fedimint's client file is a redb file whose format follows the pinned wasm build, not the browser | From reading code and SDK sources. Nothing was moved with funds |

To be measured before or during phase 1, each with its experiment. A row that fails changes the section it names.

| Unknown | Experiment | Section it decides |
|---|---|---|
| `V`: how long after a put is sent to one relay a `NetworkOnly` read of **another** relay, and a Desktop's read of the DHT, shows that packet; and whether a relay answers 204 before or after its own put to the DHT is done | Put through one public relay, read through the other and through a Mainline node every 250 ms; a few hundred rounds at different hours | [Settle](#settle-how-a-raised-turn-becomes-active): `T` is `P + 2V`, and the 30 seconds there assume `V` under 10 seconds |
| How long the turn's own Mainline node on Desktop needs from a cold start to its first answer, against the 8 second source timeout | Start the node cold on several networks, time the first lookup | [Publishing and reading](#publishing-and-reading) |
| Relays other than `pkarr-relay` 2.1.0: whether they honour `?policy=NetworkOnly`, and what such a read costs of a relay's limits | The same requests against other relay versions; many `NetworkOnly` reads in a minute against the public relays | The same. A relay that ignores the policy serves its cache for 300 seconds, and the settle read cannot count on it |
| Public Mainline nodes at an equal sequence, and whether they honour `cas` (local nodes do; local nodes replace at an equal sequence) | Put two values from two clients, read from several nodes | The same |
| How long a relay serves a record nobody puts again | Put once, read at 3, 12 and 24 hours | [When a device checks](#when-a-device-checks) |
| Whether a database commit without strict durability can be lost, per engine | Kill the browser process (and a VM) right after the commit, with and without `strict` | [Durable device state](#durable-device-state) |
| Non-extractable Ed25519 keys in WKWebView, WebKitGTK, WebView2, Firefox and iOS Home Screen Safari | A ten-line page that generates, stores, reloads and signs | [Terms](#terms) |
| Whether a moved Arkade database opens with the same balance, and what the provider says about a stale copy | Mutinynet wallet, move there and back; ask the provider ([202](202-arkade.md) lists it as an open gate) | [Wallets](#wallets) |
| Bark: store names and value types of both databases; whether a snapshot taken after the SDK stops opens elsewhere with the same balance; the SDK's recovery default | One look at a live wallet in the browser's tools; signet wallet, move and open | The same |
| Fedimint: does the SDK back up to the guardians by itself, does recovery return the full balance, does a client file copied to another browser open | Funded regtest federation, move and recover | The same |
| Spark: does `getPayment` by idempotency key work on a rebuilt database | Regtest, two browser contexts | The same |
| The group windows and the hold manifest against a raised counter | Unit tests with the floor and the stride | [Raised counters](#raised-counters) |
| Whether invite parsing in 1.0.x refuses an unknown invite version cleanly | Unit test against the 1.0.x parser | [Adding a device](#adding-a-device) |
| The Bark and Ark renewal windows as dates a person can be shown | Read the expiry from each SDK on a Testnet wallet | [Wallets that stay home](#wallets-that-stay-home) |

## Model

### Terms

- **Device**: one install of a client holding (or able to hold) the profile: a Desktop app, a browser's web app, an extension. Two browsers on one machine are two devices.
- **Device signing key**: an Ed25519 key made on the device, in no backup and in no handoff. (The name avoids `deviceKey`, which the code already uses for the local key that seals a seed, `packages/browser/src/engine/did.ts`; in code this one is `deviceSigningKey`.) It is described as what it is: where the WebView offers Ed25519 in WebCrypto, the key is generated non-extractable, so **the app cannot export it**; it is still bytes in the browser's storage on disk, and copied storage copies it. Where WebCrypto lacks Ed25519 (Safari before 17, and any WebView not yet verified), the key is a stored seed like every other key in the profile. No OS keychain is used. The device signing key does three things: it signs the turn record, it authenticates the device's links, and it signs a release. Because the app may hold no seed for it, `PairedSession` takes a **signer** (`sign(bytes)` returning a signature, asynchronous) for a device link, where today it signs from a raw seed (`packages/core/src/pairedSession.ts`); a chat's seed is wrapped in the same interface.
- **Device set**: the devices enrolled in one profile, at most 4. It has one secret, the **device-set secret** `D` (32 bytes), held by every enrolled device.
- **`D` is the authority.** Whoever holds `D` can write the turn record and can enroll a key. Device signatures say which device wrote and let the others show it; they do not limit a holder of `D`. A backup of an enrolled profile contains `D`, so **a backup holder is a `D` holder**.
- **The first `D`** is derived from the profile's DID key, which every backup already carries: `D0 = HKDF-SHA256(ikm = DID seed, salt = "ghostly-devices/1", info = "device-set", 32)`. So a bundle made before the profile had a second device still leads a 1.1 app to the turn record. After a device is removed, `D` is random (see [Removing a device](#removing-a-device)).
- **Turn**: a counter. The device that holds the highest turn is the active one.
- **Device link**: an authenticated channel between two of the person's devices. It is an ordinary paired chat session ([401](401-paired-chat.md)) whose keys are **derived from `D` and the two device signing keys**, so any two enrolled devices have one without ever having met, and a removed device has none once `D` changes:
  - `linkSecret = HKDF-SHA256(ikm = D, salt = "ghostly-devices/1", info = "link" || lowerKey || higherKey, 32)`;
  - each side's rendezvous seed is `HKDF(linkSecret, info = "rv" || ownSigningKey)`, the link's sealing key `HKDF(linkSecret, info = "enc")`;
  - each side's participation key **is its device signing key**, pinned from the turn record. Trust on first use is off for a device link (`trustOnFirstUse: false`; chats default to on, `packages/core/src/ghostlink.ts`).
  A holder of `D` can compute both rendezvous seeds, so it can disturb a link's rendezvous; it cannot pass the session's authentication without a device signing key. The link reuses the transports ([100](100-transports.md)) and the file transfer ([501](501-paired-files.md)) and is never listed among chats.
  A device link offers every transport both devices run, as a chat does: WebRTC, Iroh and HyperDHT (the Desktop's own, a browser's through the person's HyperDHT relay, on a standby too). Where one side has no WebRTC (the Linux Desktop), both start their native transports side by side, and one that does not start or goes away is started again after 10 seconds, then twice as long each time up to 2 minutes. So an Iroh relay that one side cannot reach still leaves HyperDHT.

Choice recorded: the reviews offered "derive the links" or "two devices only in phase 1". Links are derived. Two devices would have been simpler to test, but removal and a third device both need a link between devices that never enrolled each other, and deriving the link also retires the bearer secret that a first design showed in the QR code for the life of the link.

### States of a device

| State | Meaning | What it does on the network for this profile |
|---|---|---|
| `single` | The profile has no device set (today's behaviour, and every CLI profile) | Everything, as today |
| `active` | Holds the turn | Everything, plus the turn record |
| `standby` | Enrolled, not active. Holds its device signing key, `D`, the device set and either nothing else (**no copy here**) or a **frozen copy** of the state as it was when it last released | **Device-link-only mode**: reads the turn record, publishes and reads the rendezvous records of its device links while the app is open, answers those links. Nothing else |
| `releasing` | Was active, has frozen its database for a handoff, has not signed the release yet | Device-link-only mode. Goes back to `active` on cancel |
| `taking` | Has a turn of its own to put, or has put it and is waiting for its [settle read](#settle-how-a-raised-turn-becomes-active). A taker holds a release and a verified staged state; a device that forces a takeover holds its own copy and no release | Device-link-only mode, and the put of its turn record |
| `superseded` | Found a higher turn that it did not release. Its copy has forked from the active one | Device-link-only mode |
| `moving` | Read a tombstone that still lists it: the device set moved to a new `D` and this device has not received it yet | Device-link-only mode on its **old** links, to receive the new `D` |
| `removed` | Read a tombstone that no longer lists it | Nothing |

### The gate

Device-link-only mode is a different start, not a flag checked here and there.

- The device state is read **before** `GhostlyNode.start()` runs anything, on every client, at the one place where a host makes its engine: the web app's and the Desktop's page, and in the extension **the offscreen document**, which is where the engine starts at browser start with no page open (the background worker's `onStartup` and `onInstalled` only make that document). The pages wait for the gate before they draw. Today `start()` starts identities and the DID first, then every wallet, then chats (`packages/browser/src/engine/node.ts`); none of that may run.
- In any state but `single` and `active` the client **does not open the peer database**, with one exception: a `releasing` device opens it **read-only** to send the parts of pass 2, and closes it at the release. IndexedDB has no read-only open, so "read-only" is the client's own rule: the database is opened without a version, so nothing migrates; only `readonly` transactions are made; and if the stored version is not this build's (the app was updated between quiesce and the reload) the handoff is cancelled and the device starts as `active`. This exception is part of the handoff and is not built yet. Otherwise the client starts a small engine that knows only the device state, the turn record and the device links. So no wallet SDK starts (they start eagerly today), no DID or proof record is put, no chat or group link starts, no hold poll runs, and an app update never migrates a frozen copy.
- **A state that cannot be read** is not covered by the table of states, so it has a rule of its own: **closed only with evidence of a device set, otherwise `single`.** No `ghostly-devices` database (and on Desktop no state file): the profile is `single`. Listing the databases fails or takes more than 2 seconds: no evidence, `single`; a profile that was never enrolled must not be locked out by a slow browser. The database exists and does not open or answer within 8 seconds, or holds a record this build cannot read, or the Desktop's file holds something that is not this profile's record: `unreadable`, which starts nothing but the standby screen with "Try again". A read never makes the database; only a write does.
- **Profile peek** ("Check other profiles", [04](04-profiles.md#checking-other-profiles)) skips a profile that is not `single` or `active`: it reads mailboxes with the profile's own keys, which a standby must not do, and a standby would show unread counts.
- The notice of [the newer-version check](#versions) is never raised by a frozen copy: nothing opens it.
- **The push worker** reads the device state itself, from the `ghostly-devices` database, each time a push arrives, and picks its notice from it ([Push and the phone](#push-and-the-phone)). It needs no message from a page.
- A standby writes nothing into a frozen copy, ever. What it must do without the profile database is listed where it arises: deleting the Breez database by its name, and serving files left for later from an index. Both the index and the Breez database's name are written beside the device state **at quiesce, before the reload into the gate**. One write breaks this rule in the first part as built, and is to be removed: the lock screen stands in front of the standby screen, and its counter of wrong attempts is a local key under the profile's own prefix. It moves beside the device state, and it is left out of the `local` part of a handoff.
- Stopping is done by **writing the state and reloading into the gate**, never by trusting each SDK to close. Bark runs a background daemon and Fedimint holds an exclusive file handle; a reload ends both.

### Durable device state

The device state decides safety, so it is stored apart and strictly:

- a small database of its own, `ghostly-devices`, one record per profile, **keyed by the name of the profile's peer database**: state, turn, `rev`, the stored signed turn packet, the device set, `D`, the takeover count, the handoff in progress (role, step, staging namespace, the release), the highest turn it ever signed a release for, the highest sequence it ever saw at the turn address in a packet that verified (see [Publishing and reading](#publishing-and-reading)), a count of its own writes, and, written at quiesce, the index of files left for later and the name of the Breez database; for each earlier device set (at most 8): its old `D`, its tombstone packet, its signed `set-update` frame and the devices that have not yet acknowledged it. A profile with no record is `single`. (An earlier text also listed a "lineage" here and never said what it is. Phase 1 has none: the field is reserved for the incremental handoff of phase 3, and a reader ignores it.);
- the released turn, the highest sequence seen and the takeover count only rise. The legal changes of state are one table in the code; any other change is refused and writes nothing;
- a change is read, checked and written under a Web Lock, and the write transaction checks the stored write count, so two pages cannot write over each other;
- every write uses `durability: "strict"` and waits for the transaction to complete. The Desktop also writes the same record to a file through a Rust command (temporary file, `fsync`, rename, `fsync` of the folder), the file first and the database second. At start it takes **the stricter of the two** and brings the other in line: a copy whose state does not run the engine wins over one that does (`single`, `active`); when that does not decide (both run it, or neither does, as with `standby` in one and `superseded` in the other), the copy with the higher write count wins; a record wins over none. Bringing a copy in line after a crash is a write that is no legal change of state, so that table is not applied to it;
- the profile's own storage is found through the registry ([04](04-profiles.md#local-model)); a handoff installs a new storage namespace by changing one pointer (see [Installing](#installing-the-staged-state)). Since the device record is keyed by the peer database's name and a new namespace has a new name, the record is written under both names before the pointer moves.

"Durably" in this document means exactly this. The guarantee assumes a strict write survives a crash and a power loss; whether each engine honours that is on the measurement list.

### Adding a device

Today's path is a backup restored on the second device. It copies every secret through a passphrase file, leaves the first copy running, and nothing tells either copy about the other. Enrollment replaces it.

**Conditions.** The profile has a lock password of at least 8 characters (the lock screen allows 4 today; a device set needs 8), typed again on the active device to open **Add a device**. That is also when a profile whose lock password already existed gets its handoff verifier ([Authorizing a handoff](#authorizing-a-handoff)): the app has the password in hand only then. A password under 8 characters must be changed first. On iPhone and iPad the new device is the app on the Home Screen: a Safari tab has other storage, so **Add this device to my profile** is offered only in the installed app, and a tab says "Add Ghostly to your Home Screen first." Elsewhere the client calls `navigator.storage.persist()` and, when it is not granted, warns and goes on: "This browser may clear Ghostly's data. Keep a copy on <device>."

**The invite.** A new invite version (the bech32m code of [800](800-invite-join.md), version symbol 2), since today's has four fields and no flag, expiry or use count (`packages/core/src/invite.ts`):

| Field | Size |
|---|---|
| One-time rendezvous seed for the joiner | 32 bytes |
| One-time link key | 32 bytes |
| The inviter's one-time rendezvous key | 32 bytes |
| The inviter's device signing key | 32 bytes |
| Flags (bit 0: own device) | 1 byte |
| Expires, UNIX seconds | 4 bytes |

It is shown as a QR code and as a link to copy or share, and read through the existing `JoinDialog` (scan, paste, open an image). The QR code and the link are the code in the fragment of a link to the web app, `https://app.ghostly.tools/#<profile>#ghostly1z…` (the web app's own origin when the active device is the web app), the form chat invites use (`inviteLink`, `inviteQrSegments`): a phone's own camera then opens Ghostly with the code, which no request carries. `<profile>` is the name of the profile the device is added to, escaped, at most 32 characters, with no `#`; it goes before the code because every reader takes the code after the last `#`, so an app that does not know it reads the code alone. The name is only shown ("Add this phone to <profile>"); nothing checks it, and the digits remain the check. The app takes the code out of the address before anything else reads it. Readers take the bare code or either form of the link. The code may travel by any channel the person likes: the digits below protect it. The inviter enforces the 10 minutes and the single use; an app from before this WISP does not know version 2 and must refuse the code.

**Where a code goes on the new device.** Every route to a code (the camera opening the link, Join on the chat list, "I already use Ghostly", "Add this device to another profile", a paste) ends on one screen, in whatever profile is open. Before the person presses its button the app asks the engine whether the code may go into this profile (`deviceEnrollReady`: `ready`, or `set`, `in-use`, `loading`). A profile that holds something (the rule of `deviceEnrollJoin`, which still decides) or is already on several devices, and any profile on standby, never takes the code: the button makes a new, empty profile, named after `<profile>`, and that profile goes on to the session by itself once it starts, waiting while its wallets load. The new profile inherits the lock of the one it came from; the lock the person passed in this tab is handed across that one reload, and the one into the standby screen, through a marker in the tab's session storage that names the profile and its password hash and is good once, for 15 seconds. An app with one profile only says the profile is in use.

**The session** is a paired session on that one-time link, with capability `enroll/1`. Its participation keys are the two device signing keys: B pins A's from the invite; A, for this one session only, accepts the first joiner's key, which is exactly what the digits then confirm. Its frames:

1. `B → A` `{"t":"enroll-hello","k":"<B's device signing key>","name":"Phone","kind":"web","app":"1.1.0","s":"<signature>"}`, signed with B's device signing key over `["ghostly-enroll", transcriptHash, A's key, B's key]`. The transcript hash is the session's ([401](401-paired-chat.md)); device signing keys are not in it, which is why both are signed in here.
2. `A → B` `{"t":"enroll-proof","s":"<signature>"}`, the same tuple signed with A's device signing key. B checks it against the key in the invite.
3. Both compute six digits: the first 32 bits of `SHA-256("ghostly-enroll-digits" || transcriptHash || A's key || B's key)`, big-endian, as a decimal number modulo 1,000,000 with leading zeros. The transcript hash goes in as its 32 bytes. Not 20 bits: 2^20 is 1,048,576, so modulo a million the values under 48,576 would come up twice as often as the rest; with 32 bits the bias is about one part in 4,295.
4. The person confirms on A that both screens show the same digits.
5. `A → B` `{"t":"enroll-grant","d":"<D>","set":[[key, name], ...],"turn":N,"rev":R}`. B stores it durably as `standby` and answers `{"t":"enroll-done"}`.
6. A publishes the turn record with B listed. Only then is B a device.

Two rules make the digits enough, without a commitment round:

- **One session per invite.** A admits the first joiner that authenticates and voids the invite. A second joiner gets nothing, and A says so.
- **B shows digits only after it verified A's proof** against the invite's key.

So an attacker who photographed the code and joined first holds A's only session; the person's own device shows an error and no digits, and nothing is confirmed. An attacker cannot sit between the two either: B knows A's key from the code. If step 5 or 6 does not finish, B holds nothing usable (it is not in the record) and shows "Not finished" with **Remove**; A adds no device.

**Transports of the session.** As on a device link, each side says in its own packet which transports its app runs and how to dial its native ones (`_tr`), signed with its device signing key. A side with no WebRTC (the Linux Desktop) starts its native endpoints at once; a side with WebRTC starts its own as soon as the other side's packet says it has none. B checks A's value against the key in the code. A has no key to check B's against until a joiner authenticated, so until then it takes B's value unchecked, as where to dial and nothing more: whoever can write that packet holds the code and could be the first joiner anyway, and the session there still authenticates. Without this, a page with WebRTC never reached a Desktop without it, and when A's one-time key sorted first (A dials) it had nothing to dial.

**When the two cannot connect.** A says "A device is connecting" from the moment it sees B's packet on the link (`seen` on its waiting view), so the person knows the code was read. B waits 2 minutes for A's proof. If B saw A's packet on the link and no session opened, it says "The two devices found each other but could not connect", and so does A, 2 minutes after it first saw B's packet with no session: neither screen waits out the code's 10 minutes in silence. A B that never saw A says "Your other device did not answer".

Enrollment transfers `D` and the device set, **nothing else**: no chat key, no wallet, no storage credential. The new device ends on the standby screen, which offers the first handoff at once: "Bring my profile here now · 480 MB".

### A backup restored where a device set exists

A backup of an enrolled profile carries `D`, the device set and the turn it was made at, never a device signing key (stripped like the push subscription and the storage credentials are today). A bundle made before enrollment carries the DID key, from which a 1.1 app derives `D0`. Either way the client, before it registers the restored profile:

1. derives the turn address and reads the record ([Publishing and reading](#publishing-and-reading));
2. finds **no record** and no device set in the bundle: restores as today (a profile that was never enrolled). A record that expired because every device was off for hours is missed here, which is a limit until every profile keeps a record ([open question 3](#decisions-and-open-questions));
3. finds **a record with a device active**, or **no record (`none`) while the bundle itself carries a device set** (the record expired; the devices may still be alive): does not start the copy. It says "This profile is active on <device>" and offers **Add this device instead** (enrollment, then a handoff: the safe path), **Take over** (a [forced takeover](#forced-takeover), for when the other devices are gone) or **Cancel**;
4. finds **a tombstone** (the device set moved to a new `D` after a removal): says "This backup is from before a device was removed. Starting it makes a second copy of your profile." It cannot take over (it has no current `D`). It may start only as a profile of its own, after the person types the profile's name, and that copy is the "two live copies" case of [05](05-backups.md#security-and-operation), which nothing here can stop;
5. **cannot read** the record (`unreachable`, or `closed`): with a device set in the bundle, does not start the copy, and says so. With none (a bundle made before enrollment) the profile may or may not have devices now, and nothing tells which: the copy is restored and starts in [limited mode](#when-a-device-checks), marked in its own settings store before it is listed (`restoreTurnUnchecked`), so the gate starts its engine limited. Everything can be read; nothing is published, dialled, paid or settled, no group is changed and no door duty taken. The engine reads the turn of the first `D` every 30 seconds: `none` clears the mark and ends limited mode (a profile of one device, as in case 2); a record with a device active makes the copy a restored standby, as in case 3 (a device signing key of its own in a free slot), whose screen offers **Take over**; a tombstone keeps it limited until the person types the profile's name to start it as a profile of its own, as in case 4. A line above the chat list says "Restored copy, offline for now", with the reason behind ⓘ. Starting it live with no read would make it a second live copy wherever the profile has gone on to have devices.

A start from a bundle is a forced takeover in every case: the bundle is older state. An app from before this WISP cannot be stopped from restoring a bundle that it can read; see [Compatibility](#compatibility-and-rollout).

### Removing a device

Phase 1 includes removal: the phone is the device most likely to be lost, and the superseded screen offers it. Only the active device removes. On it: Profile, Devices, Remove. The client, in this order:

1. makes a new random device-set secret `D'` (so a new turn address and new device links), the **tombstone** for the old address, and one signed `set-update` frame;
2. **stores all of it durably before anything leaves the device**: `D'`, the old `D`, the tombstone packet, the signed frame, and the list of staying devices that have not acknowledged. A crash after this point resumes from step 3; a crash before it means nothing happened;
3. puts the turn record at the new address, without the removed device. Nobody else holds `D'` yet, so this first record has no rival and needs no settle wait;
4. puts the tombstone at the old address, and puts it again every hour while the profile exists;
5. sends the frame to each staying device over its old link (authenticated by device signing keys, so the removed device cannot join that session), and again at every session until that device answers.

**The frame**, under a capability `devices/1` that only device links offer:

```
{"t":"set-update","d":"<D'>","set":[[key, name], ...],"turn":N,"rev":R,"tomb":"<the tombstone packet>","by":"<the remover's device signing key>","s":"<signature>"}
{"t":"set-ack"}
```

`s` is the remover's signature over `["ghostly-set-update", old turn address, d, set, turn, rev, SHA-256(tomb)]`. The receiver writes `D'` and the tombstone packet durably as `standby` under `D'`, then answers `set-ack`; one that already holds that `D'` just answers.

**Who a `moving` device believes.** A device that was off reads the tombstone, finds itself still listed, becomes `moving`, and shows "Open Ghostly on <active device> to finish". It **accepts a `set-update` only when it is signed by the device signing key that its own stored turn record, the last one it accepted before the tombstone, names active, and that key is still listed in the tombstone.** Other holders of `D'` do answer a `moving` device on an old link, but only by **forwarding that signed frame unchanged**; they sign nothing of their own. Without this check a removed device, which still holds the old `D` and a valid old link, could write a tombstone of its own and hand a `moving` device a secret of its own.

Two cases the rule leaves, stated:

- **The stored active device is the removed one**, or is not listed, or the signature fails (the device was off across a takeover, so its stored record is older than the remover's turn): nothing is accepted. The device shows "Your devices changed while this one was off. Add this device again from the device you use now." and is enrolled anew, where the six digits and the person decide. It costs one enrollment.
- **The stored active device was later removed and means harm**: it can sign a `set-update` this device accepts. That device held the whole profile when this one last looked, and nothing cryptographic tells its word from the remover's. So a device that accepts a `set-update` shows the new device list once ("Your devices are now: ...") and the person can refuse it.

**The tombstone** is the turn record with turn 2^32 - 1 and no active device (`active` is 255). Its slots keep the devices that **stay** and are zero for the removed one, so a device that reads it knows which it is: still listed means `moving`, not listed means `removed`. It is signed by the removing device from its own slot; its `rev` is 0, it carries no release (the release fields are zero) and its `instance` is random. A reader takes a tombstone with any `rev` and any `instance`, and refuses one with a release. **Every tombstone has the one sequence number 2^52 - 1**, whatever its author's slot: ordinary records stop at turn 2^32 - 2, so no record can outrank a tombstone and its hourly put is never refused as older.

What a tombstone is for: it tells an **honest** device that was removed or left behind, whenever it comes back, to stop. Both states it leads to do nothing on the network, so a false one costs liveness, never safety. It is not a lock: a DHT node accepts another packet at an equal sequence and a relay keeps whichever of the two compares larger (both measured), so any holder of the old `D`, the removed device included, can replace it for as long as it likes. A staying device that such a forgery sends to `removed` is added again by enrollment, which uses a one-time link and needs nothing of the old set; once enrolled under `D'` it never reads the old address again, so the forgery costs each device one enrollment at most.

**What is kept, and where.** Beside the device state: the tombstone packets of earlier device sets (at most 8, the oldest dropped), each one's old `D`, its signed `set-update` frame and its list of devices that have not acknowledged. They **move in a handoff** (the part `devices`), so whichever device is active puts the tombstones and goes on delivering the frame.

**When the remover is gone for good.** A `moving` device is not stuck: **My other device is lost or broken** there makes a new device set of its own (a new random `D`, itself the only device) from its frozen copy, as a forced takeover, and says that other devices must be added again. It puts, at the old address, a tombstone that lists only itself, then **settles** as a raised turn does ([Settle](#settle-how-a-raised-turn-becomes-active)): it waits `T`, reads every source again, and **starts only if the tombstone there is its own**. If it reads another valid tombstone that does not list it (a second `moving` device did the same), it does not start and is `removed`; if it reads both, the lower `instance` is the one that counts, for both devices alike. The earlier text said that reading the tombstone back at once was enough for two such devices never to both run. It is not: every tombstone has one sequence, at an equal sequence a DHT node keeps the packet that came last and a relay the one that compares larger, and no put is refused for writing over the other. With the wait, both devices read the same packet when they read the same sources, and one starts. When their sources disagree for longer than `T`, both can start (two device sets; each finds the other's tombstone at its hourly put and tells the person) or, when each reads only the other's, neither does, and the profile comes back by a restore. **Every device that puts a tombstone follows one rule when it finds a different valid tombstone in its place: it shows "<device> started a device set of its own" (or "Something else closed your old device set"), and stops putting its own.** A remover that was alive after all keeps running under its `D'`, since it is the active device there, and the person removes the stray set; the tombstones do not ping-pong.

What removal can and cannot do depends on what the removed device held:

| The removed device was | Someone holding it unlocked can | Cannot | What the person should do |
|---|---|---|---|
| A standby with no copy | Read the old turn record (device names, the turn). Ask for a handoff until removed, which needs the lock password, with limited attempts ([Authorizing a handoff](#authorizing-a-handoff)) | Read a message, reach a contact, touch money | Remove the device. Nothing else |
| A standby with a frozen copy | Read all history up to its last release: **a frozen copy is not encrypted**, and the lock password is a screen gate only. Act as the person to every contact, read new DHT texts and held items (they are sealed to the chats' static keys), and spend from every wallet whose seed or credential is in the copy | Take the turn under `D'` | Remove the device, then the money steps and the chats below |
| The active device | The same, with current state | The same | Force a takeover from another device, then the same |

**Removal protects the turn, not the keys.** Chats have no key rotation ([02](02-peer-keys.md) leaves it open), so a copied chat key stays valid until the chat is paired again. So the forced-takeover and the remove screens ask **Lost or stolen?** and, on yes, lead to the money step first:

- **Phase 1: a written checklist**. First line, when the lost device held a copy and storage is set up: "Change your storage keys" (the copy holds the credentials of the hold and backup storage; the keys are changed at the provider and typed again here). Then one line per wallet the lost device could spend from, each with its button where one exists: Cashu, "Swap all ecash now" (every proof is swapped at its mint, so the copies are spent); wallets with a phrase, "Make a new wallet and send the funds to it"; remote Lightning, "Revoke the connection at your node". The guided flow that does these in one pass is phase 2.
- **Chats.** Each chat is paired again with a new invite; the contact sees a new chat. For a group, the admin removes the member key and adds a new one. This costs every contact an action, and the client says so.
- **Later.** A participation-key rotation bound to the old key ([02](02-peer-keys.md)) would let a chat move to a new key without a new invite. It is the real fix and is not designed here.

## The turn

### Record

The turn record is one Pkarr packet under a key only holders of `D` can derive:

- turn identity: `identityFromSeed(HKDF-SHA256(ikm = D, salt = "ghostly-devices/1", info = "turn", 32))`;
- seal key: `HKDF-SHA256(ikm = D, salt = "ghostly-devices/1", info = "turn-seal", 32)`;
- one TXT record under the label `_s` (a label that says nothing; once this format is public, an observer can still tell the record's kind from it) = base64url of `nonce(24) || XSalsa20-Poly1305(sealKey, nonce, body)`.

The body is **binary and of fixed length**, so every record has one size and nothing needs padding or escaping:

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | Version, `1` |
| 1 | 4 | `turn`, unsigned, big-endian; at most 2^32 - 2 in an ordinary record, 2^32 - 1 in a tombstone |
| 5 | 3 | `rev`, unsigned, under 2^18; 0 in the first record of a turn |
| 8 | 1 | `author`: index (0 to 3) of the device that signed this record |
| 9 | 1 | `active`: index of the active device, or 255 in a tombstone and nowhere else |
| 10 | 1 | Number of slots held, 1 to 4: the author always holds one, so it is never 0 |
| 11 | 192 | Four slots of `signingKey(32) || name(16, UTF-8, zero-padded)`. A slot nobody holds is zero. After a removal the slots held need not be the first ones |
| 203 | 8 | `instance`: random, made by the active device each time its engine starts |
| 211 | 1 | Release present, 0 or 1 |
| 212 | 1 | Release: `from`, the index of the device that gave the turn up |
| 213 | 1 | Release: `to`, the index of the device it was given to |
| 214 | 32 | Release: `H`, the digest of the state handed over; zero in a release from a device to itself |
| 246 | 64 | Release: `from`'s signature over `"ghostly-turn-release" || turnAddress(32) || turn(4) || toKey(32) || H(32)` |
| 310 | 64 | The author's signature over `"ghostly-turn" || turnAddress(32) || body[0..310]` |

374 bytes of body, 414 sealed, 552 characters of base64url: **a DNS packet of 634 bytes and a relay payload of 706 bytes, measured, the same for 1 to 4 devices**. A device keeps its slot for life. A name longer than 16 bytes is cut at a character a person sees as one (a grapheme), so an emoji sequence is kept whole or dropped.

**The packet is canonical.** DNS lets a TXT value be cut into strings in more than one way, and the two writers built so far cut the 552 characters differently (255, 255, 42 in TypeScript; 254, 254, 44 in the Rust library), so one record had two packets and the test vectors could pin only the body and the sealed value. A writer MUST make this packet and no other: one answer, name `_s.<the turn key in z-base-32>`, class IN, type TXT, **TTL 300** (the TTL is inside the signed bytes; 300 seconds is also how long a relay may answer from its cache), no name compression, and the value cut into strings of 255 bytes with the rest last (255, 255, 42). A reader joins the strings of whatever cut it is given, so a packet cut another way still reads. The vectors (7 records and 30 invalid packets, read by the TypeScript and the Rust suites) then pin the whole packet. The Rust writer does not make the canonical cut yet.

**The BEP44 sequence number is `turn * 2^20 + rev * 4 + author`**, not the clock (a tombstone alone has the fixed sequence 2^52 - 1). `rev` starts at 0 in each turn and rises by one with every record the active device writes in it (a start, a device added or renamed). If `rev` would reach 2^18, or if a packet that verifies under the turn key and holds no valid record sits at or above the last sequence of the turn (so nothing the active device could write in its turn would be above it), the active device writes the next turn instead, with a release from itself to itself; readers accept a release whose `from` and `to` are both the device that was active. Every later record of a turn carries the turn's release unchanged. The first turn is random under 2^29, so the sequence stays under today's microsecond clock and the absolute count says nothing; the highest value, the tombstone's, is 2^52 - 1, exact in JavaScript and far from the dates a relay cannot format. Folding the author's slot into the low bits means **two enrolled devices never sign an equal sequence**, whatever they race on: each has its own slot. The one exception is two copies restored from backups that both take over at once and pick the same free slot; that is settled as a clone is, below. A lower sequence is refused by a DHT node (302) and by a relay (409), both measured; a stale device that tries to put its old record back learns from the refusal that it was replaced.

A reader accepts a record that: verifies as a BEP44 packet under the turn key; opens under the seal key; has version 1 and a consistent layout; is signed by the key in its own slot `author`; has a sequence equal to the formula above for its turn, `rev` and author (or, for a tombstone, to 2^52 - 1); and, when a release is present, whose release verifies under the key in slot `from`, names the record's turn and the key in slot `to`, with `to` equal to `active`. A reader that knew the previous record also checks that `from` was the active device there, and shows a mismatch as a takeover without a release. A reader that holds no record of the set yet (a device just enrolled, a restore) takes the first valid record it reads as the current one and shows no takeover for it: the first record of a set has no release, and without an earlier record that cannot be told from a takeover. "Not lower than the highest it holds" is no rule of validity: a lower record is valid and is what the result `behind` is made of; the comparison belongs to the read, below. **A record is written by the device it names active**: a record whose `author` differs from its own `active` is invalid and dropped, a tombstone excepted (its `active` is 255 and its author is the remover). So a holder of `D` cannot quietly add a slot at a higher `rev` under someone else's turn; it can only write a record that names itself active, which every device shows as a takeover. **Of two valid records at one turn** (a taker with a release and a third device forcing the same turn, for example) **the higher sequence wins**, which the slot in the low bits makes the same for every reader; the device whose record lost reads `other`, and a running active device that finds another device's valid record at its own turn with a lower sequence reads `behind`. One exception protects a takeover: **a `taking` device yields to any other valid record at its turn**, whatever the sequences, so a third device that forced the same turn is not overridden by a taker in a higher slot that saw its record. A taker that never sees it (its put replaced that record at every source) does not yield; the forcing device then reads `other` at its settle read, and one device is active either way.

**An unknown signer is accepted.** A record with no release whose author is a key the reader never saw is a forced takeover by a holder of `D` (for example a restored backup with a new device signing key). It is valid, it supersedes, and every device shows it as such. This follows from "`D` is the authority"; a rule that refused it would leave two devices active for ever.

If two valid records at one sequence ever meet (they cannot be signed by two enrolled devices; a clone, or two restored copies in one slot, can do it), a reader compares the opened bodies and keeps the one with the lower `instance`; with an equal `instance`, the lower body, then the lower packet, compared as bytes, so every reader still agrees. Its writer goes on and writes `rev` plus one at once, and the other stops. Nothing on the network settles this: **`cas` does not guard an equal sequence** (a DHT node stores the second packet even with a matching `cas`), and a relay keeps the packet whose encoded bytes compare larger and answers 409 to the other, which for a sealed record is random. So the rule is the reader's own and never a library's (the `pkarr` crate prefers the larger bytes too), and the copy whose packet a relay refused learns of the other from the refusal. A device that is still settling a raised turn applies no tie-break: it stops (see [Settle](#settle-how-a-raised-turn-becomes-active)).

### Publishing and reading

The turn has its own publish and read path. The chat path (`packages/core/src/relay.ts`, the Desktop's `relay_put` and `Dht::publish`) is wrong for it in four ways: it reads until the first relay answers, it calls a put done when one relay took it, it sends a refused conditional put again without the condition ("one writer per key, so insist"), and the Desktop passes no compare-and-swap value.

**What the sources do, measured.** The first text of this section counted on a put being refused when it would write over a record its writer had not read. Building it showed where that holds:

- A lower sequence is refused everywhere: 409 from a relay, error 302 from a DHT node.
- **Relays ignore `If-Match`.** `pkarr-relay` 2.1.0 and both default relays store the packet whatever sequence the condition names. A conditional put exists on the DHT only (`cas`, refused with error 301 on a mismatch), and a browser reaches the DHT only through relays. So **in the web app and the extension no put is ever refused for writing over a record its writer never read.**
- **Nothing guards an equal sequence.** A DHT node stores a different packet at an equal sequence and replaces the first, with no `cas` and with a matching one. A relay keeps the packet whose encoded bytes compare larger and answers 409 to the smaller.
- **A relay answers a read from its cache** for the packet's TTL (300 seconds). Only `?policy=NetworkOnly` makes it ask the DHT.

So refusals do not protect the turn. What decides who is active is the [settle read](#settle-how-a-raised-turn-becomes-active); a condition is still sent, because a source that honours it tells the writer sooner.

**Put.**

- A device signs and seals a record once and **stores the packet's bytes**. Every later put of that record sends the same bytes: a fresh nonce at the same sequence would be a different packet, which a node replaces the first with and a relay keeps or refuses by its bytes.
- A device stores a packet durably **before** it puts it, so what it finds on the network after a crash is never newer than what it holds.
- A device keeps the **highest sequence it ever saw at the address in a packet whose BEP44 signature verified under the turn key**, whether the record inside was valid or not (a node stores such a packet, so it stands in the way of a lower one). **A sequence that a source only reports never counts.** A relay answers 404 with the header `pkarr-invalid-signed-packet-seq` for an item it could not parse; a device that believed that number would let a relay close the address (by naming 2^52 - 1) or push the active device into the next turn, with no key at all. Only bytes whose signature the device checked itself move the mark. The cost: a web or extension device whose put is refused (409) under an item the relay will not show stays `behind` until that item expires or a Desktop, which reads the item from the DHT and can verify it, writes above it.
- A record a device writes always has a sequence above that mark; otherwise an invalid record with a high `rev` would make every later put fail as older. When the mark leaves no room in the turn, the active device takes the next turn by a release to itself ([Record](#record)). A mark can only be moved by a holder of `D`.
- **One condition per source.** Sources disagree, so each put names what that source held at the read: `cas` on the DHT, `If-Match` on a relay. A source that held nothing gets no condition; a source that held only an invalid packet has a sequence, and the put names it. A source that did not answer the read is not put to. Only a put that ends `behind` after three rounds goes out with no condition at all.
- **A refusal is an answer, never retried without the condition, and never sent to that source again.** Error 301 or 302 from a node, 409 or 412 from a relay, mean someone else wrote: read.
- The put reports each source's answer; "one relay took it" is not success by itself.
- **Desktop puts to the DHT first, and to the relays only if the DHT stored the packet.** A relay would take the packet whatever it held, so a put that `cas` refuses must not reach one. The `pkarr` crate's DHT client hides `put_mutable`, so the turn has a Mainline node of its own. That node is built when the app starts a profile that has a device set, not at the first read: a cold node needs time to find the network, and the 8 seconds of a source are not known to be enough (to be measured). **A lookup on it that finds nothing is `unreachable` for that source, never "no record"**: a node that has not found the network yet finds nothing either.
- The active device puts its stored bytes at start and every hour. An identical packet refreshes the item without an update ([310 did:dht](310-did-dht.md#publishing) measured 204; the turn record's relay measured the same).

**Read.**

1. Ask **every** configured relay with `?policy=NetworkOnly`, and on Desktop the DHT itself, in parallel, 8 seconds each. A cached answer would hide a record another device put elsewhere for up to five minutes. The policy makes the relay look the key up on the DHT, which counts against that relay's own limits and against the 30 requests a minute the profile has there.
2. Verify each answer under the turn key and open it; drop what fails. An answer whose signature verifies moves the mark of the highest sequence seen even when its record is dropped; nothing else does.
3. Take the highest sequence among the answers. The locally stored packet is what the answers are compared with; it is never counted as an answer.
4. The result is one of:

| Result | Meaning |
|---|---|
| `mine` | **A source returned**, as the highest record, byte for byte the packet this device stored, and nothing this device ever saw verified is above it |
| `behind` | Sources answered, and the highest they hold is below what this device holds or has seen: an older turn, this device's own earlier record, another device's valid record at this device's own turn with a lower sequence, or (for a device that does not write) any record below the highest sequence it saw. The put reached nobody, or the newer record expired, or a source lags. A device that writes puts its stored packet again, naming what it read, and reads again. It is not `mine` until a source returns it. After 3 rounds a `taking` device treats it as `unreachable` (it waits and tries later) and an active device as `none` (it puts with no condition) |
| `other` | A higher turn; or another device's valid record at this turn with a higher sequence; or, for a `taking` device, another device's valid record at its turn at any sequence |
| `clone` | A record **at or above this device's stored sequence**, authored from this device's own slot, that is not its stored packet: another copy of this device's storage wrote it, or (with another key in the slot) a second restored copy took the same free slot. A device's own last record, found again after a restart, is its stored packet and reads `mine`, whatever `instance` it carries |
| `tombstone` | The address is closed by a valid tombstone; the reader is either still listed (`moving`) or not (`removed`) |
| `closed` | A packet that verifies under the turn key sits at or above 2^52 - 1 and is no valid tombstone. No ordinary record can be put above it, and only a holder of `D` can have made it. See [When the address is closed](#when-the-address-is-closed) |
| `none` | At least one source answered, and none has a record |
| `unreachable` | No source answered. On Desktop, a DHT lookup that found nothing counts as that source not answering |

A read is **good** when at least one source answered and the result is not `closed`. Both default relays are run by one operator (`packages/core/src/relay.ts`), so in the web app and the extension "several relays" gives no independence: one operator can hide a newer record. Desktop also asks the DHT.

### Settle: how a raised turn becomes active

Since no relay refuses the second of two puts, a device that reads its own record back straight after its put learns nothing. With a taker in slot 1 that puts first and a third device in slot 2 that forces the same turn a moment later, both puts are stored, each device reads its own packet back, and both are active. A refused conditional put was meant to stop the second one; in a device set of web apps and extensions it never comes.

So every device that **raises the turn** (a taker, a forced takeover, a start from a backup) follows one rule, with two constants: `P` = 10 seconds and `T` = 30 seconds.

1. It reads the turn. Its put must be sent within `P` of the start of that read; if it cannot be, it reads again first.
2. It puts, as `taking`, with its packet stored.
3. It waits `T`, counted from the end of the put (every answer in, or timed out).
4. It reads every source again, with `NetworkOnly`. This settle read counts only if **every source that took the put answers**; with fewer it is `unreachable`: the device waits and reads again.
5. **It goes active only if the result is still `mine`.** On `other`, `clone`, `tombstone` or `closed` it does not start, and does what its row in the table below says. On `behind` or `none` its put was lost: it starts again at step 1. A settling device applies no tie-break of `instance`: any packet at or above its own sequence that is not its own means it does not start.

A device that crashes while it settles starts again at step 1 with its stored packet; it cannot know when it put, so it waits the whole of `T` again.

**Why the wait is enough, and what `T` must exceed.** Let `V` be the longest time from the moment a put is sent until every source shows that packet to a `NetworkOnly` read. Take any two devices that raise the turn, X with the lower sequence and Y with the higher. Y's record is the highest there is, so Y reads `mine`. X also reads `mine` only if Y's packet is not yet visible at X's settle read, which means Y sent its put later than `T - V` after X sent its own. But Y sent its put at most `P` after the start of its read, and that read did not show X's record (a taker that sees another record at its turn yields, and a forcing device that sees it takes the turn above it, which is a takeover of a device it was shown, in the list of detected cases below), so Y's read started less than `V` after X's put. Together, Y's put came less than `P + V` after X's. Both cannot hold when

`T >= P + 2V`.

So `T` must exceed the put window plus twice the time a put needs to become visible, not `V` alone: the put window is what stops a device from putting, late, on the strength of an old read. `V` is made of the relay's own put to the DHT, the time the packet needs to reach the nodes another relay's lookup asks, and that lookup. With `NetworkOnly` the relay's cache is not part of it; a relay that ignores the policy answers from its cache for 300 seconds, and against such a relay no practical `T` holds (both default relays and `pkarr-relay` 2.1.0 know the policy). **`T` = 30 seconds assumes `V` under 10 seconds, and `V` is not measured**: on a local testnet a put is visible at once, and the time between two public relays is on the list of things to measure. If the measured `V` is larger, `T` is `10 + 2V` seconds; if it is much smaller, `T` shrinks with it.

Checked against every order, for two and three devices (`A` released turn `N + 1` to taker `B`; `C` and `D` force without a release; slots compared as `b`, `c`, `d`):

| Case | Puts, in time order | After the settle reads |
|---|---|---|
| Two devices, a normal handoff | `B` alone | `B` reads `mine` and is active. `A` is `standby` since before the release existed, so this case needs no timing at all; the wait only costs time |
| Taker and a forcing device, `b < c` | `B`, then `C` | `C`'s packet replaces `B`'s (higher sequence). `B` reads `other` and yields; `C` is active |
| The same slots | `C`, then `B` | `B`'s put is refused as lower (409, or 302), or lands only on a source that lags; `B` reads `other`; `C` is active |
| Taker and a forcing device, `b > c` | `B`, then `C` | `C`'s put is refused as lower; it reads `other` and does not start; `B` is active |
| The same slots | `C`, then `B` | If `B`'s read before its put showed `C`'s record, `B` yields without putting and `C` is active. If not, `B`'s packet replaces `C`'s; `B` no longer sees `C`'s record and reads `mine`, `C` reads `other`, and `B` is active |
| Two forcing devices, no taker | Either order | The higher slot reads `mine`, the lower `other` |
| Three devices at one turn (`B`, `C`, `D`) | Any of the six orders | Each pair is one of the rows above, so only the highest sequence that was put can read `mine` |
| A forcing device whose read already showed `B`'s record | `B`, then `C` at turn `N + 2` | `B` reads `other` if it is still settling. If `B` was already active, this is a forced takeover of a live device: detected, not prevented, as before |
| Two restored copies in one free slot (an equal sequence) | Either order | Relays keep the larger packet, so both read the same one: its writer is active and the other stops. Where sources keep different packets for longer than `T` (DHT nodes do), both can read `mine`: detected at the next read |
| Relays only, or Desktop and web mixed | | The same rows. On Desktop `cas` refuses, on the DHT, a put over a record it did not read, so a Desktop that loses often learns it before the wait; it still waits, because a web device's put through a relay can replace its record without any refusal |

**Some honest device can always start.** Among devices that raised one turn, the one with the highest sequence reads `mine` once its sources answer. If it is gone before it settles, the others have read `other` and nobody is active: the person presses the button again on one of them, which reads the stale record, takes the turn above it and settles alone. A releaser whose taker is gone takes over at `N + 2`, as before.

**What this changes for the person.** The last step of every handoff and of every takeover now takes about half a minute in which no device is active, shown as "Checking which device is active". The measurements force it: without the wait, two devices can both start, and nothing tells them for up to ten minutes. An ordinary start of the active device does not wait, and neither does a release from a device to itself: that device is active throughout, puts, reads again after `T`, and stops only if the read is not `mine`.

### When the address is closed

`closed` is the one result the first text had no rule for. A packet at or above 2^52 - 1 that is no valid tombstone can be made only with the turn key, so by a holder of `D`: an attack, or a broken client. Nothing can be put above it at this address while it is there, and it lasts as long as someone puts it again (a node keeps an item about two hours).

- **It is never a good read.** Every state does what it does on `unreachable`: an active device goes on without opening a wallet, spending or doing admin work, and does not start by itself; a `taking` device waits; the others stay. The screen says "Something else closed your device set" in place of "Can't check which device is active".
- **Exits.** (1) The packet expires and the next read is an ordinary one. (2) On the device whose durable state is `active`, or `taking` with a stored release: **New device secret**, the steps of [Removing a device](#removing-a-device) with nobody removed. The tombstone cannot be put at a closed address; the signed `set-update` carries it, and goes over the old device links, which still work. Because that device cannot read the turn, it cannot rule out that another device took the turn before the address was closed, so this is done as a [forced takeover](#forced-takeover) is: confirmed by the person, counters raised, admin work off. (3) Every other device takes that `set-update` under the rule a `moving` device follows (signed by the device its stored record names active) and is `standby` under the new `D`; or it is enrolled anew. (4) A device with a frozen copy whose active device is gone for good uses **My other device is lost or broken**, which makes a device set of its own as a `moving` device does. At a closed address no tombstone can arbitrate between two devices that do this, so the screen says to do it on one device only.

A hostile holder of `D` can close each new address only if it also holds the new `D`, which it does not.

### Who may raise the turn

- The device that takes a normal handoff, with the release of the device that was active.
- The active device itself, with a release from itself to itself, when `rev` runs out or when a packet with no valid record stands at or above the last sequence of its turn. It stays active throughout; this is the one release that is not preceded by writing `standby`, and the one raise that changes nothing about who is active.
- A device that forces a takeover, with no release. The record says so, and every other device shows it. Its turn is one above the highest turn it knows, **counting any release it signed itself**: a device that released turn `N + 1` and then takes over uses `N + 2`, so the taker's held release can never outrank it.

A handoff and a takeover each need the person to press a button, and each ends with the [settle wait](#settle-how-a-raised-turn-becomes-active). Nothing else raises the turn; the release to itself moves the number, never the active device, and only a packet signed with the turn key can make it necessary (a sequence a relay merely reports cannot).

### When a device checks

A relay read is not free: the web app and the extension share 30 requests a minute per relay with every chat ([04](04-profiles.md#checking-other-profiles)), and a turn read asks with `NetworkOnly`, which makes the relay look the key up on the DHT each time. The turn is not read before every send. An active device reads it:

- **at start, as a condition of starting.** With a good read that says `mine` or `none` it writes its next record (`rev` plus one, a new `instance`), stores it, puts it and starts. With `unreachable` it shows "Can't check which device is active" with **Try again** and **Start anyway**; started that way it runs in **limited mode** until a good read: **nothing is published, nothing is dialled and nothing is settled in hold storage**; no wallet is opened and no admin work is done. It is the profile offline, exactly as the engine is offline today: history can be read and settings changed, and a message is taken only where the offline engine already takes one. **A message to a contact is refused** with today's "You are offline": the engine keeps no outbox for a 1:1 message written while it is offline, and limited mode adds none (an earlier text promised one). The read is tried again every 30 seconds, and the first good one either starts the engine properly or stops the device;
- when the app comes back to the front, the network changes or the machine wakes;
- every 10 minutes (with jitter) while it runs;
- when its last good read is older than 60 seconds, **before** each of: a Mainnet spend; opening a single-writer wallet SDK on any network (Fedimint, Spark, Ark, Bark); a group commit; taking door duty in a community. If the read is not good, the action does not happen;
- at once on a hint: a device link that says "I took the turn"; a refused put of its own record; one of its own chat records (its capability record or mailbox) carrying an inner counter higher than its own; a contact's session replaced by another dial-in where the transport reports it.

A hint is never authority. A contact or a relay cannot make a device give the turn up; it can only make it read the record.

A standby reads the record when its screen is opened, every 10 minutes while it shows, and on **Use here** when its link to the device it believes active is down (a device removed meanwhile then shows that it was removed).

### When a device finds itself superseded

On `other`, on `clone` above its stored sequence, or on `tombstone`, at once: it writes `superseded` (on a tombstone, `moving` or `removed`) durably and **reloads into the gate**. Nothing is said to contacts and nothing more is published. The reload ends every session, timer and wallet SDK. Its state stays as it is; what only it holds is the subject of [After a forced takeover](#after-a-forced-takeover).

On `clone` above its stored sequence, the copy that reads it stops: the other copy wrote a newer record that this one never stored. That is the copy that started last, so an original that has run since before the copy was made stops at its next read and the fresh copy goes on; which of the two is "the original" cannot be told from inside. On `clone` at an **equal** sequence (both started in the same moment), the lower `instance` goes on and **writes `rev` plus one at once**, so the network holds one record again; the other stops. On relays the copy whose packet compares smaller gets 409 for its put and reads at once; the other learns at its next read. This detects a cloned storage at the clone's next read, which the first design could not.

### Device state by turn read

Every state, against every result of a read. No cell is empty, and every state has a way out.

| State | `mine` | `other` | `clone` | `tombstone` | `none` | `unreachable` |
|---|---|---|---|---|---|---|
| `active`, at start | Write the next record, store, put, start | `superseded` | Above its stored sequence: `superseded`, shown as "Another copy of this device is running". At an equal sequence: the lower `instance` writes `rev` plus one and starts, the other is `superseded` | `moving` if listed, else `removed` | Write the next record, store, put with no condition, start | Do not start; "Try again" or "Start anyway" (offline only) |
| `active`, running | Go on | `superseded`, reload | As at start | `moving` or `removed`, reload | Put the stored packet again, go on | Go on; no wallet opened, no spend, no admin work until a good read |
| `standby` | Its own last record is still the highest it ever saw: it released and the taker has not put its turn yet. Show "Moving to <device>. Waiting for it to finish." | Show "Active on <device>" | Treated as `other` | `moving` or `removed` | Show the device it last knew as active; a handoff still needs that device | Show "Can't check which device is active" |
| `releasing`, at start | Write `active`, then as `active` | `superseded` | `superseded` | `moving` or `removed` | Write `active`, then as `active` | Write `active`, then as `active` at start |
| `taking` | At the settle read, `T` after its put: write `active`, start. Before that: wait | Pointer back, drop staging, `standby` (this includes any other device's valid record at its turn). A device that was forcing a takeover goes back to the state it had | The same | The same, then `moving` or `removed` | Put again, naming nothing, and settle again | Wait, try again |
| `superseded` | Never read: its stored packet is below the turn that superseded it, which it keeps as the highest it saw, so its own packet coming back (the newer record expired, or a relay lags) is `behind`, treated as `none` | Stay; **Use here** (a handoff) or **It wasn't me** (a takeover) | Stay | `moving` or `removed` | Stay; it never puts its packet again. The same two buttons; **It wasn't me** takes the turn above the one that superseded it, expired or not | Stay |
| `moving` | Stay: the tombstone expired at that source, or the source lags | Stay, the same | Stay, the same | If it no longer lists this device: `removed`. If it does: stay until a `set-update` signed by the device its stored record names active arrives, then `standby` under the new `D`; or enrollment anew; or a takeover into a device set of its own | Stay (the tombstone expired; the active device puts it again) | Stay |
| `removed` | n/a | n/a | n/a | Stay; **Add it again** is a new enrollment | Stay | Stay |

`behind` has no column: a device that writes (`active`, `taking`) puts its stored packet again and reads again, three rounds at most, then `taking` treats it as `unreachable` and `active` as `none`; any other state treats it as `none` and puts nothing. So no device ever takes a record below the highest sequence it saw as news: a newer record that expired does not make an older one current again.

`closed` has no column either: every state does what its `unreachable` cell says, with the exits of [When the address is closed](#when-the-address-is-closed).

What the table and the rules above give, stated so a reviewer can check each:

- **Every state has an exit.** `superseded` leaves by a handoff or a takeover; a `verified` taker leaves by a release, a cancel or its own read; `taking` leaves at its settle read, to `active` or back; `moving` leaves by a signed `set-update`, by enrollment anew, or by a takeover into its own set; `behind` ends after three rounds; `removed` leaves by enrollment; a device that reads `closed` leaves when the packet expires, by a new device secret, or by enrollment.
- **Honest devices are never all unable to start.** After a release, the taker finishes alone, and if it is gone the releaser takes over at `N + 2`. Of several devices that raised one turn, the highest sequence reads `mine` at its settle read; if that device is gone, another takes the turn above it. With no record on the network, an active device puts its own. With no source reachable, an active device opens offline and starts at the first good read. After a removal, the active device runs under the new `D` and the others wait for it or, if it is gone, start a set of their own.
- **Two enrolled devices never sign an equal sequence**: the slot is in the low bits, `rev` only rises inside a turn and is 0 in a new one, and a releaser's takeover skips the turn it released.
- **At most one device goes active after its settle read**, as long as a put is visible to every source within `V` ([Settle](#settle-how-a-raised-turn-becomes-active)). This replaces "a refused put stops the second writer", which no relay does.
- **A tombstone is never outranked**: it has the one highest sequence, and ordinary turns stop one below its turn.
- **A device's own record after a restart is never read as a clone**: it is stored before it is put, `mine` is a comparison of bytes, and `clone` is by definition a packet that is not the stored one.

### Failure cases

| Case | What happens |
|---|---|
| Normal handoff, the old device then goes offline for a month | Nothing to do: it wrote `standby` durably before it signed the release, so it never acts again without a handoff back |
| Forced takeover while the old device is off; it comes back | It reads the higher turn at start, before the engine starts, and becomes `superseded` without publishing |
| The same, and it comes back where no relay answers | It does not start by itself. **Start anyway** gives limited mode, which publishes, dials and settles nothing and refuses a message to a contact, so it opens no double-active window |
| The record expired (a DHT node keeps an item about two hours) while every device was off | The first device to start reads `none`. An active one puts its stored record and goes on. A standby stays a standby. If a stale active device returns first, the newer one, at its own start, reads the lower record and puts its higher one, and the stale device stops at its next read or refused put |
| Clocks wrong by days | No effect on the turn. A clock far ahead still makes that device's chat packets win during a double-active window, as today |
| A relay operator hides the new record | A web or extension device that reads only that operator is not told it was replaced. Desktop also reads the DHT. Hints remain |
| A buggy standby that publishes chat records | The active device notices its own records carrying counters it did not write, reads the turn, finds itself still active, and reports "Another copy of this profile is acting" with the device list. It cannot stop the other copy |
| A holder of `D` writes a record inside the current turn (a slot added at a higher `rev`) | Invalid for every reader: its author is not the device it names active. The active device keeps its turn, notes the sequence (the packet verifies under the turn key), writes its own record above it, in the next turn by a release to itself if the turn has no room left, and shows "Something else changed your device list" with **Remove a device** |
| A hostile holder of `D` raises the turn | The real device becomes `superseded`. Its screen offers **It wasn't me**: take the turn back and remove that device, which moves the set to a new `D` |
| A device's storage was copied (a disk image, a phone restored to a new phone, a browser profile folder) | Two installs share one device signing key. The copy that did not write the newest record reads one from its own slot that it never stored, at its next read, and stops. If the original has not restarted since the copy was made, that is the original |
| A taker and a third device that forces the same turn put seconds apart | No relay refuses the second put. Each waits `T` after its put and reads again: the lower sequence (or the taker, when it sees the other record) reads `other` and does not start. One device is active, `T` later than before |
| The same, and the second put becomes visible later than `V` | Both read `mine` at their settle reads and both start. The one with the lower sequence stops at its next read (at most about 10 minutes) or at its next refused put |
| A relay names a sequence for an item it will not show (404 with `pkarr-invalid-signed-packet-seq`), or names 2^52 - 1 | Ignored: it moves no mark, closes nothing and raises nothing. If a real item is there, puts under it are refused and the device stays `behind` until the item expires or a Desktop reads and outranks it |
| A packet signed with the turn key sits at or above 2^52 - 1 and is no tombstone | `closed`: nobody starts by itself, a running active device goes on without wallets or admin work, and the active device offers **New device secret** ([When the address is closed](#when-the-address-is-closed)) |
| The newer record expired and a relay still serves a `superseded` device its own old packet | It stays `superseded`: the turn that superseded it is stored as the highest it saw, so its own packet is `behind`, and it never puts it again |
| The Desktop's Mainline node has not found the network yet | Its lookup finds nothing, which counts as that source not answering, never as "no record". With relays answering, the read is good without it |
| The device state cannot be read | With evidence of a device set (the database exists, or the Desktop's file holds something): nothing starts, "Try again". With none: the profile is `single` and starts |

### What is and is not guaranteed

**Guaranteed, for a normal handoff only:** at most one device is active at any moment, with no dependence on relays, clocks or timing. Assumptions: both apps are unmodified; neither device's storage is copied or rolled back from outside; a strict durable write survives a crash and a power loss; no third device or restored copy raises the turn at the same time. The reason: the old device makes itself `standby` durably before it signs the release; the release names its taker; the taker starts only once it holds that release, has verified the whole state, has put its turn, has waited `T` and has read it back as its own. This never rested on a put being refused, so the measurements leave it whole. Between the two there is a time with no active device, never two; it is now at least `T`.

**Held by the settle wait, while the network is in time:** when two or more devices raise the turn at once (a taker and a third device forcing the same turn; two forced takeovers; two restored copies in different slots), at most one goes active. The first text had a refused conditional put prevent the second writer. No relay refuses one, so this now rests on a wait and on three assumptions: each put is visible to every source's `NetworkOnly` read within `V` (10 seconds assumed, not measured); the relays honour `NetworkOnly`; no operator hides a record. A Desktop adds `cas` on the DHT, which refuses a put over a record its writer did not read, except at an equal sequence.

**Detected, not prevented** (bounded by the next good read of the turn record, at most about 10 minutes while a source answers):

- a forced takeover while the old device is alive, including one over a device that is still settling;
- a start from a restored backup, when the person chooses Take over;
- cloned storage;
- two devices that raise the turn at once when one of the three assumptions above fails: both read `mine` after `T` and both start. This is the case that moved here from "prevented": a taker against a forcing device, in a device set that reaches the DHT only through relays;
- two restored copies that took the same free slot and so wrote an equal sequence, where sources keep different packets.

**For a device set of web apps and extensions only**, in one place: a normal handoff is safe with no timing. Two devices raising the turn at once are kept apart by a wait of `T` = 30 seconds, which holds while a put shows on the other relay within 10 seconds, and are otherwise both active until the next read, about 10 minutes at most. No put is ever refused there for overwriting an unread record, and a relay operator who hides the newer record defeats both the wait and the read.

**What a double-active window costs.** Contacts see sessions replaced back and forth. A text over the DHT from the device with older counters is dropped. Held items can be lost: a device whose `outSeq` is behind what the contact already acknowledged holds new items under old numbers, and the contact's acknowledgement then settles them as delivered and removes them unread (`packages/browser/src/engine/hold.ts`). Group messages are dropped as already seen. What the limits above rule out even in the window: a second writer in a single-writer wallet, a Mainnet spend, a group commit, door duty.

**Not guaranteed:**

- anything against a modified app or a holder of `D` who means harm;
- that a relay shows the newest record;
- that contacts enforce anything: they cannot see the turn;
- anything about an app from before this WISP that is given the profile's storage or a bundle it can read.

### Should contacts refuse a superseded device?

They cannot today: a contact sees chat keys, and both devices hold the same ones. Letting them would add a number that only grows with handoffs to `pair-offer`, the capability record and the mailbox envelope. It is left out: it tells every contact when the person changes device and how often, it changes three formats and the group frames, and it guards only messages. Listed as an optional later phase.

## The handoff

### Shape

A handoff is a copy with one writer. `A` is the active device, `B` the one that takes, `N` the turn. It can start from either side: **Use here** on `B` (a pull) or **Move to <device>** on `A` (a push, for leaving the house with both devices in hand). After the first frame both are the same.

1. **Hello.** Both send their versions ([Versions](#versions)). A mismatch that cannot work ends here, before a byte is copied.
2. **Authorize.** A pull proves the lock password to `A` ([Authorizing a handoff](#authorizing-a-handoff)). A push needs no password: the person pressed the button on the unlocked active device, and `B` asks "Move this profile here from <A>?" with **Use here**.
3. **Pass 1, files, while `A` stays live.** `B` sends the digests of the files it already holds. `A` sends a manifest of the files `B` lacks and then the files. `A` goes on sending and receiving for the person all the while, and Cancel loses nothing. Files are written once and named by their SHA-256, so what `B` already has (a frozen copy from last time) is skipped. On mobile data, files over a size are left for later by default.
4. **Quiesce.** `A` refuses if a payment is running ([Payments in flight](#payments-in-flight)), cancels reviews not yet approved, says `paired-bye` on its chat sessions, writes `releasing` durably and reloads into the gate. From here `A` answers no dial-in from a contact and its database does not change. `A` still holds the turn: a cancel or a failure from here to step 7 returns it to `active` by one write and a reload.
5. **Pass 2, the rest.** `A` sends the manifest of everything else (the peer database, the profile's local keys, wallet databases that move, files that arrived during pass 1) and then the parts. This is small next to the files: the offline gap is seconds to a minute for the copy, plus the half minute of the settle wait in step 8, not the length of the whole copy.
6. **Verify.** `B` checks every part against the manifests, computes `H`, checks room and versions, and answers `handoff-verified`.
7. **Release.** `A` writes `standby` durably (released turn `N + 1` to `B`, digest `H`), **then** sends `handoff-release`. From the durable write on, `A` is on standby even if the frame never arrives.
8. **Take.** `B` stores the release durably as `taking`, installs the staged state, reads the turn, puts the turn record `N + 1` (naming `N` to each source), **waits `T` and reads every source again** ([Settle](#settle-how-a-raised-turn-becomes-active)), and only on `mine` writes `active` and starts the engine. It tells `A` (`handoff-done`). If the put is refused, or the settle read shows another record, someone else wrote: `B` stays `taking` or becomes `standby` as the record says. Both screens show "Checking which device is active" for this step.

**Cancel is safe until step 7.** A drop between 7 and 8 leaves nobody active, never two; so does the wait inside step 8. `B` needs nothing more from `A`: it holds the release and the verified state, and finishes alone when it has a network. `A`, meanwhile, shows "Moving to <B>. Waiting for it to finish." and **Use here**; that button reads the turn first: if `N + 1` exists it answers "<B> finished the move. This device is on standby."; if the turn is still `N`, it is a forced takeover and says so, **at turn `N + 2`**: the release `A` signed was for `N + 1`, so `A`'s takeover must outrank it whatever the slots are. `B`'s put of `N + 1` is then lower than what the network holds and is refused (a lower sequence is refused by relays and nodes alike); `B` reads `other`, at the latest at its settle read, and drops its staged state. `A` settles like any device that raises the turn. If `B` was still waiting for the release, `A` answers its next request with `handoff-cancel`, which `B` accepts after a release only when its own read of the turn shows a turn above the one the release named.

A contact's dial-in during the gap finds nobody, as when the app is closed. Contacts cannot call or pay meanwhile; their apps say so with today's words ("Calls need a live connection", "Payments need a live connection"), and texts wait in the DHT mailbox or a hold.

### Frames

All frames travel on a device link only, under a capability `handoff/1` that only device links offer. They carry no message id, as other session frames that older apps drop.

| Frame | From | Body |
|---|---|---|
| `handoff-hello` | both | `{"v":1,"e":"<X25519 public key, made for this handoff>","app":"1.1.0","db":<DB_VERSION>,"pins":{"ark":"0.4.74","bark":"0.25.0","fedimint":"<build>","breez":"<version>"},"kind":"web","room":<bytes free>,"metered":<bool>}` |
| `handoff-request` | B | `{"turn":N}` |
| `handoff-offer` | A | `{"turn":N}`; B answers with `handoff-request` once the person agrees |
| `handoff-busy` | A | `{"why":"handoff" or "payment" or "call" or "locked-out","retry":<seconds>}` |
| `handoff-pake` | both | `{"n":1 to 3,"m":"<base64url>"}`, the three OPAQUE messages of the password proof; frame 3 also carries `"c"`, the context proof, or `"wrong":true` when the taker found the password wrong |
| `handoff-have` | B | `{"part":"<name>"}`: a file part, sent first, holding the 32-byte digests of the files B holds, sorted |
| `handoff-manifest` | A | `{"pass":1 or 2,"parts":[[name, size, sha256], ...]}` |
| `handoff-verified` | B | `{"h":"<H>","s":"<B's signature over [\"ghostly-handoff-verified\", turnAddress, N + 1, H]>"}` |
| `handoff-release` | A | `{"turn":N + 1,"to":"<B's key>","h":"<H>","s":"<the release signature of the turn record>"}` |
| `handoff-done` | B | `{"seq":<the sequence it read back>}` |
| `handoff-cancel` | either | `{"why":"..."}`. From A it is valid before `handoff-release`; after it, only once A holds a turn above the released one, which B checks by reading the turn |
| `handoff-file-request` | the active device | `{"sha256":"<digest>"}`: asks a standby for a file left for later; answered by a file transfer of the part `file/<sha256>`, or `{"t":"handoff-file-missing","sha256":"..."}` |
| `device-wake` | any device | `{"w":{...} or null}`: this device's push target, in the shape of `paired-wake` ([401](401-paired-chat.md#wake-up-push)), with a token of its own. Sent on each new device-link session and when it changes |

Parts travel as files of [501](501-paired-files.md) (resumed from confirmed bytes after a drop), each sealed (XSalsa20-Poly1305, a random nonce per 1 MiB piece) with the handoff's **stream key**. A paired session has no key of its own, so the handoff makes one: both sides send a fresh X25519 public key in `handoff-hello`, and `streamKey = HKDF-SHA256(ikm = X25519(e_A, e_B) || K, salt = the session's transcript hash, info = "ghostly-handoff-stream/1", 32)`, where `K` is the shared key of the password proof on a pull and empty on a push. The session's signed transcript binds the hello frames to the two device signing keys. A part's `name` is one of `db/<store>`, `local`, `file/<sha256>`, `wallet/<type>/<name>`, `devices` (what [Removing a device](#removing-a-device) keeps for earlier device sets).

**`H`** is `SHA-256` of the UTF-8 bytes of `JSON.stringify(["ghostly-handoff/1", N + 1, fromKey, toKey, parts])`, where `parts` is every part of both passes and every part `B` already held and keeps, as `[name, size, sha256]` with `sha256` in base64url, sorted by `name` as byte strings. Only arrays, strings and integers appear, so the form is canonical.

### States and events

One handoff at a time per profile: a second request gets `handoff-busy`.

| A is | Event | A does | Next |
|---|---|---|---|
| `active` | `handoff-request`, or the person presses Move to | Checks versions; starts the password proof (pull) | authorizing |
| `active` | A request while a call is on, or from a locked-out device | `handoff-busy` | `active` |
| authorizing | Proof fails | Counts the attempt, notice on screen, `handoff-busy` when the limit is reached | `active` |
| authorizing | Proof holds; no frame for 60 s | Cancels | `active` |
| offered (a push) | A new session of the link, or B's hello or `handoff-have` of an earlier attempt, or B's hello for this offer on a later session than its first (its request was lost) | Sends the offer again | offered |
| pass 1 | `handoff-have` | Sends manifest 1 and the files | pass 1 |
| pass 1 | No confirmed bytes for 1 minute, or the link drops | Pauses; resumes when the link is back | pass 1 |
| pass 1 | Nothing from B for 2 minutes, the link up or not | Fails as `stalled`: `handoff-cancel` `stalled` when the link lets it, "The move stopped" with Try again (which offers the move again, a push) | `active` |
| pass 1 | All files confirmed | Tries to quiesce; if a payment runs, waits up to 30 s, then `handoff-busy` `payment` | quiescing or pass 1 |
| quiescing | Database frozen | Writes the index of files left for later and the Breez database's name beside the device state, writes `releasing`, reloads into the gate, opens the database read-only, sends manifest 2 and the parts | pass 2 |
| pass 2 | The link drops, nothing from B for 2 minutes before every part is confirmed, or no `handoff-verified` within 10 minutes of the last part | Writes `active`, reloads, starts, and says why once it runs again | `active` |
| pass 2 | `handoff-verified` with a valid signature and the same `H` | Writes `standby` durably, sends `handoff-release` | `standby` |
| `standby` (just released) | `handoff-request` again from B with the same turn | Sends the same release again | `standby` |
| `standby` | `handoff-done` | Deletes its Breez database by the name it noted at quiesce; touches nothing in the frozen copy | `standby` |
| `standby` (released, no `handoff-done` yet) | `handoff-offer` from the device it released to | The same as `handoff-done`: that device holds the turn | `standby` |

| B is | Event | B does | Next |
|---|---|---|---|
| `standby` | The person presses Use here, or accepts an offer | Dials A, hello, request | requesting |
| requesting | No session within 30 s | "Can't reach <device>. It must be on, with Ghostly open." Sends a wake push to A when A shared a target | `standby` |
| requesting | `handoff-busy` | Shows why | `standby` |
| requesting, receiving or verified | `handoff-offer` from A with another handoff's id | A runs no handoff when it offers one, so the earlier attempt is over there: drops the staged parts of pass 2, keeps the files, shows the offer | `standby` |
| receiving (a push, no manifest yet) | `handoff-offer` from A with this handoff's id | A never got the request: sends it again on this session, once per session, with this session's stream key | receiving |
| receiving | Parts | Writes to staging, checks each digest; a bad part is asked again once, then the handoff fails | receiving |
| receiving | Nothing from A for 2 minutes, the link up or not (either pass) | Fails as `stalled`: `handoff-cancel` `stalled` when the link lets it, "The move stopped" with Try again; keeps the staged files, which the next pull from A within 24 hours does not fetch again | `standby` |
| receiving | All parts of pass 2 | Verifies, sends `handoff-verified` | verified |
| verified | No release within 60 s | Reads the turn, then asks again each time the link is back; never starts without a release | verified |
| verified | `handoff-cancel`, or its own read shows a turn above `N` | Drops the staged parts of pass 2, keeps the files | `standby` |
| verified | `handoff-release` that verifies | Writes `taking` durably, installs | `taking` |
| `taking` | Install done | Reads the turn, then puts `N + 1` within `P`, naming `N` to each source; waits `T`; reads every source again | `taking` |
| `taking` | First read says `none` (A's record expired) | Puts `N + 1` with no condition, waits `T`, reads again | `taking` |
| `taking` | Settle read says `mine` | Writes `active`, starts, sends `handoff-done` | `active` |
| `taking` | Read says `other` or `clone` | Moves the registry pointer back, drops the staged state | `standby` |
| `taking` | Read says `tombstone` | The same, then as the tombstone says | `moving` or `removed` |
| `taking` | Read is `unreachable`, `closed`, or a settle read that a source which took the put did not answer | Waits and tries again; shows "Finishing: waiting for the network". A read again that took longer than `P` puts nothing, and waits as well | `taking` |
| `taking` | No settled read (`mine`, or a turn above the release) within 2 minutes of the install or of Try again, a take that never answers included | Stops trying: "Can't check which device is active. Check your connection, then try again." with Try again, which takes again for 2 minutes more. A take still out is not dropped: its answer, when it comes, is acted on. Nothing is undone: the release is still this device's | `taking` |
| `taking` | Settle read says `behind` or `none` (the put was lost) | Starts again at the read before the put, and waits `T` again | `taking` |
| `taking` | The app restarts during the wait | Reads, puts the same stored bytes, waits the whole of `T` again | `taking` |

### Authorizing a handoff

The active device is often unattended (the desktop at home while the person is out), so it cannot be asked to confirm. A pull is authorized by the device link (the device signing keys of the turn record) **and** by the profile's lock password, typed on the taking device and proven to the active one without sending it:

- **Protocol:** OPAQUE ([RFC 9807](https://www.rfc-editor.org/rfc/rfc9807)) with ristretto255 and Argon2id, an augmented exchange: the active device stores a verifier, not the password, and a stolen verifier still costs a dictionary attack. The build uses `@serenity-kit/opaque`, the Rust crate `opaque-ke` compiled to WebAssembly (an earlier version of the crate was audited by NCC Group in 2021), loaded only when a handoff or a verifier needs it. The verifier is the server setup and the registration record, made on the active device when the person types the lock password (Add a device, the password set or changed), and it moves with the profile in its settings. A new verifier replaces one only when the current password proves itself against it, the same way a pull does. The password is stretched with Argon2id on the taking device, which is memory-hard. The three messages are the three `handoff-pake` frames: `B → A` the login request, `A → B` the login response, `B → A` the finishing message.
- **Binding:** the context is `"ghostly-handoff/1" || turnAddress || A's key || B's key || the session's transcript hash`. OPAQUE's identifiers are sealed into the envelope at registration and cannot name a session, so the context is bound in two other ways: frame 3 carries `c = HMAC-SHA256(K, "ghostly-handoff-context/1" || context)`, which A checks, and the shared key `K` goes into the stream key ([Frames](#frames)), so on a pull the state is unreadable without the password even to someone who broke the link.
- **Attempts:** the active device counts failures per taking device. After 5 in an hour it answers `handoff-busy` `locked-out` for an hour; after 15 with no success between them it refuses that device until the person, on the active device, chooses "Let <device> try again". Every failure raises a notice on the active device: "<device> tried to move this profile with a wrong password."
- **What it protects:** a stolen standby with no copy cannot pull the profile, and gets a handful of guesses. It does not protect a frozen copy: that data is already on the stolen device, unencrypted.

Why OPAQUE and not SPAKE2+ (RFC 9383, the first draft's choice, with PBKDF2-SHA256): no maintained, reviewed JavaScript implementation of SPAKE2+ exists, and writing one would mean building a protocol from primitives. OPAQUE gives the same properties that matter here (augmented, three messages, a shared key to bind), comes from a reviewed library, and stretches the password with a memory-hard function.

### Versions

The first frame carries the app version, the database version (`DB_VERSION`) and the pinned version of each wallet SDK, so a handoff that cannot work fails before the copy:

- A device takes only what its app can read. `B` with an older database version than `A` is refused: "Update Ghostly on this device first."
- A newer `B` migrates the state on arrival, as an app update does. `A` is then the older one, and must update before it can take the profile back; its standby screen says, in the words the app already uses for this, "This profile was last used by a newer version of Ghostly." and "Update the app to open it." On the installed web app, updating is Settings, Updates, Check now.
- A wallet whose SDK pin differs between the two devices does not move in that handoff; it stays home ([Wallets that stay home](#wallets-that-stay-home)).
- A frozen copy is never opened and never migrated by an app update.
- `DB_VERSION` is whatever the build holds; this document pins no number. It is 12 in the released 1.0.3 and 13 with devices, and it moves for reasons that have nothing to do with devices.

### Installing the staged state

`B` never writes into a live profile. Incoming parts go to a **staging namespace**: a new storage namespace as a restore makes one ([05](05-backups.md#restore) already writes "every store and key before the profile is registered"), with its own peer database, local keys and file area. Files `B` already held are linked into it, not copied.

- **Install** is two durable writes in a fixed order, because the device record is keyed by the peer database's name and the staged namespace has a new one. First, in one transaction of `ghostly-devices`, the record (`taking`, with both names noted) is written under the staged name as well as the old one. Then the profile's registry entry is pointed at the staged namespace. A crash between the two finds `taking` under whichever name the registry gives, and goes on. Before the pointer moves, `B`'s old frozen copy is the profile's storage; after it, the new state is. The old namespace is kept until `active` is written: if the turn does not settle as `B`'s own, the pointer moves back to it and the staged one is deleted, with its record. Only then is the old one, and the record under its name, deleted. The record under the staged name also keeps the profile's own database name (`home`, the name before any pointer, carried from one staged name to the next), so the pointer can be found again: an app that starts a profile with no pointer, no record under its own name, and a record whose `home` names it, on a database that is still there, points the profile at that namespace before it opens any storage. The app checks that the pointer write took effect before it reloads. Deleting a namespace removes its peer database, its local keys (never the registry of profiles itself: in a Desktop space of its own the first profile's keys and the registry share a prefix) and its file area, and the wallet databases that its records name **except those of a wallet whose home is this device**: a stay-home wallet's database is named by wallet id, belongs to no namespace, and its record in the new state points at the same name. On a `superseded` device the old namespace is not deleted at install: it is the fork, kept as "Only on this device" in Data and storage until the person discards it or phase 2 sends its contents over.
- A wallet's own database (Ark, Bark) arrives under a new local database name, and the wallet's record is pointed at it, as a restore does with fresh wallet ids. Nothing is written over a database that exists.
- A staging namespace that is not installed is deleted when its handoff is cancelled or fails, and at the latest after 24 hours. Settings, Data and storage, shows it ("A move that did not finish · 1.2 GB") with **Discard**.
- Room is checked with the app's own `FileBytes.room()` (`navigator.storage.estimate()` on the web) against the manifests before each pass.

Crash recovery, by what each device finds in its durable state at the next start:

| A finds | B finds | What happens |
|---|---|---|
| `active`, a handoff noted at pass 1 | `standby`, a staging namespace | B keeps the files it got; the person starts again and pass 1 skips them |
| `releasing` | `standby`, staging | A never signed a release: it writes `active` and starts. B's staged parts of pass 2 are dropped, its files kept |
| `releasing` | verified, staging | The same. B asks for the release, A answers `handoff-cancel` |
| `standby` (released) | verified, no release stored | B asks again; A sends the same release |
| `standby` (released) | `taking`, not installed | B installs, puts, waits `T`, reads again, starts |
| `standby` (released) | `taking`, installed, turn not settled | B reads, puts again (the same stored bytes), waits the whole of `T`, reads again, starts |
| `standby` (released) | `active` | Done. B sends `handoff-done` again when they next meet |
| `standby` (released) | Gone for good before its put, or its storage lost | Nobody is active. A's **Use here** reads the turn: still `N`, so it offers a forced takeover at `N + 2` from its own frozen copy, which is the state B was given |
| `standby` (released) | Lost after its put of `N + 1` was accepted | A's **Use here** reads `N + 1` and says B finished. A recovers by **My other device is lost or broken**: a forced takeover, also at `N + 2` (one above the highest turn it knows), from its frozen copy; what B did after taking is lost with B |

### What moves

Columns: whether it moves; whether it must arrive exactly once and in full; whether it could be rebuilt without the other device; what the device that goes to standby does with its copy.

In phase 1 **a device that goes to standby keeps its frozen copy**. It makes coming home cheap (only new files move), it is the only recovery if the phone's browser clears its storage, and it means there is never a moment with one copy of the profile in the world. "Keep no copy here" is a phase 2 option, allowed only while another device holds a copy.

| State | Moves | Exactly once | Can be rebuilt | On the device that goes to standby |
|---|---|---|---|---|
| Device signing key | Never | n/a | n/a | Kept |
| The current `D` and device set | Not in the stream (enrollment or `set-update` gave them) | n/a | By enrolling again | Kept |
| Earlier device sets: old `D`, tombstone packet, signed `set-update`, devices not yet acknowledged | Yes, as the part `devices`, so the new active device puts the tombstones and delivers the frame | No | No | Kept, not used |
| Chats: rendezvous seed, invite secret, participation seed, pinned contact key, trust | Yes | Secrets | No: lost keys end the chat | Frozen |
| Per-chat counters: mailbox `sequence` and `peerSequence`, capability `rev`, hold `pointerRev`, `outSeq`, `inSeq`, `peerAck`, hold mailbox name | Yes | **Yes** | No. Lower values are dropped silently by the contact | Frozen; never used again without a handoff back |
| Native transport seeds per chat | Yes | No | Yes: a new seed is a new endpoint, which the capability record then describes | Frozen |
| Sessions, dial timers, attempt counts, quotes shown but not approved, a community door's pending admissions | No (in memory) | n/a | Made again; a joiner at the door tries another hub after 30 seconds | Gone |
| Outbox: message rows in `sending`, `queued`, `waiting`, `held`, with wire ids and resend window; pending edits, reactions, pins | Yes | Ids make a resend harmless | No | Frozen |
| Message history | Yes | No | No | Frozen, not shown in phase 1 |
| Items held for contacts in the hold storage | Stay in the storage; their records move | Sequence numbers, yes | No | n/a |
| Files (OPFS, Desktop files, database pieces) | Yes, whatever the size, in pass 1, skipped when the taker holds the digest. Files left for later show as "On <device>" and are fetched over the device link when both are on (`handoff-file-request`) | No | No | Frozen. A standby serves a file over a device link, found through the index written at quiesce (digest, size, where the bytes are), without opening the profile database; that is all it serves |
| File transfers in progress with a contact | Yes | No | The transfer starts over from its checkpoint | Frozen |
| Private groups: member seed, chain, epoch secrets, send counter, seen windows, hubs used | Yes | **Send counter and, for an admin, the chain head** | A member is caught up by `group-sync` within the 32 epochs kept; an admin's wrong commit cannot be undone | Frozen |
| Communities: chain and side branches, secrets, entry seed, rendezvous secret, counters, the last 256 frames | Yes | Counters; admin chain head | Frames, from hubs; the rest no | Frozen |
| Hub role | Follows the device kind: a phone's web app taking over from a Desktop stops listing itself as a hub; a hub the admin pinned by member key degrades until the profile is back on a device that can be one | n/a | n/a | n/a |
| Identity proofs and their keys, revocation records to republish | Yes | No | No | Frozen |
| DID key and what it lists | Yes | No | No | Frozen |
| Nostr | No private key is stored; the signed event and the cache move | No | Yes | Frozen |
| Settings: name, picture, theme, language, notifications, network, mutes, drafts, read and pin state | Yes | No | No | Frozen |
| Lock password: its screen verifier and its handoff verifier | Yes | No | No | Kept: the standby screen is behind the lock |
| Shared local services and grants ([700](700-local-services.md)) | The records move. A service points at an address on one machine, so elsewhere it shows "On <device>" | No | No | Frozen |
| Hold and backup storage settings and credentials | Yes, **inside the handoff stream only**, never at enrollment. This is an exception to "never inside a bundle" ([1000](1000-storage.md)): the reader is the person's own device after the password proof, and the new active device must go on holding items for contacts | No | By typing them again | Frozen |
| Push subscription and its VAPID keys | The subscription never moves: it lives in one browser. Its **description** (what contacts are given) moves, so the active device can keep handing it out ([Push](#push-and-the-phone)) | n/a | Made new | Kept |
| Wallets | See [Wallets](#wallets) | | | |
| Profile registry entry (local name, color) | Name and color move as settings; the local profile id is each device's own | No | Yes | Kept |
| Local caches: public profiles read, link previews, last-seen balances | Yes | No | Yes | Frozen |

### Forced takeover

For a device that is lost, broken or wiped while it was active. Only a device with a frozen copy, or a copy restored from a backup, can do it. The person chooses **My other device is lost or broken**, answers **Lost or stolen?**, and confirms by typing the lost device's name. The device then:

1. reads the turn. A good read is required. Let `M` be the highest of: the turn it read, the turn it has stored, and any turn it signed a release for. On `none` there is no record to read, and `M` comes from what it has stored;
2. writes `taking` durably (with the state it had, to go back to), puts turn `M + 1` with no release within `P` of that read, naming to each source what it held (nothing after `none`), itself in its slot (a restored copy takes a free slot with its new device signing key, or the lost device's slot when all four are used), **waits `T` and reads every source again**, and goes on only if the result is `mine` ([Settle](#settle-how-a-raised-turn-becomes-active)). The screen shows "Checking which device is active" for that half minute;
3. raises its counters ([Raised counters](#raised-counters)) and adds one to the profile's takeover count;
4. starts with these limits:
   - **Admin work is off.** No commit is signed (the automatic one on a member's leave included) and no door duty is taken in any group, until the person turns on "Manage groups from this device" in that group, which says: "If your other device changed this group after <date>, managing it from here can break the group for everyone." Catching up from another member does not make it safe by itself: that member may not have the lost device's last commit. This is a risk the person accepts, written down, not one the app removes;
   - **Saved signed payments are never sent again.** Any payment attempt whose `prepared` holds signed bytes or a signed transaction (USDT; on-chain; an Ark transaction) is parked as "Needs your decision" and is neither rebroadcast nor reconciled by broadcast. Today a USDT reconcile sends the saved bytes again whenever the chain nonce has not passed them (`packages/browser/src/engine/paymentAdapters/usdt.ts`): from a months-old copy that pays a bill twice;
   - every other unfinished attempt becomes `unknown` and is only looked up, never run again (the restore rule of [05](05-backups.md#restore));
   - each wallet follows its row in [Wallets](#wallets).

Every other device shows that the turn was taken without a release.

### Raised counters

Old state means old outgoing counters. On a forced takeover and on a start from a backup, before the engine starts, the device raises **exactly these**, by `S = 2^20`:

| Counter | Where | How |
|---|---|---|
| DHT mailbox `sequence`, per chat | `dhtDeliveryState` | `+ S` |
| Capability record `rev`, per chat | `capsState` | `+ S`, and `publishedAt` cleared: a `rev` raised with unchanged content publishes nothing otherwise (`packages/core/src/capsRecord.ts`) |
| Hold `pointerRev` and `outSeq`, per chat | `hold` | `+ S` each. The object name only pads the sequence, so there is no bound to respect |
| Group send counter, mesh and community | `GroupState`, `CommunityState` | A **floor**: `floor = takeovers * S`, where `takeovers` is the profile's takeover count. The counter is set to at least `floor` now **and at every reset** (each epoch change in a mesh, each new head in a community starts at `floor`, not at 0) |

The floor is why a plain stride is not enough for groups: the counter starts over at each epoch, so a device that took over at epoch E and then catches up to E+1 would send again from 0 there, where the lost device already sent. The community beacon packs the counter in 32 bits (`packages/core/src/communityRendezvous.ts`), which allows about 4,000 takeovers in the life of a profile.

**Not raised:** edit numbers (capped at 100 per message, `packages/core/src/pairedEdits.ts`), pin numbers (clock-bound: refused more than 10 minutes ahead, `packages/core/src/pins.ts`), message ids (random), incoming high-water marks (something taken twice is removed by its id). So after a forced takeover an edit of a message that the lost device edited later can be ignored by the contact as older; the person edits again.

What contacts on any version see once, after a forced takeover: in a chat with holding on, the line "The contact holds items for you, but their address expired" and a faster poll until the first real held item; in a group, up to 255 frames counted as missing from that member. Neither loses a message. To be tested: the groups' seen windows and the hold manifest's "strictly increasing" rule with a floor and a stride.

### After a forced takeover

If the old device comes back it is `superseded`, and its state has forked from the active one. Phase 1 keeps that state untouched and says what is there ("3 messages and 1 payment are only on this device"); it deletes nothing. A `superseded` device is otherwise a standby: **Use here** takes a normal handoff from the active device, the new state is installed beside the fork, and the device is `active` (its own turn is the one it was replaced at, so the handoff names the turn that replaced it, which its mark holds; the fork is listed in the device record, `forks`, and Discard in Data and storage deletes it as a namespace is deleted); **It wasn't me** is a forced takeover from the fork. Phase 2 adds **Send what is only here** over the device link: messages and their files by id, and unspent Cashu proofs as tokens that the active device redeems at the mint (what was already spent fails harmlessly). Nothing else is ever merged: not counters, not group state, not settings.

### Later phases, in short

- **Prepared handoff (phase 2).** For "the desktop is off and I am out". The active device saves a sealed snapshot to the person's S3-compatible storage and stops. Changes the reviews require, to be specified with that phase: the handoff **names its taker** ("Save for pickup by Phone"), so its release is an ordinary release and it stays inside the guarantee; the turn record stays the releaser's last one until the taker puts the next turn (no record with `active` 255 is used: that value is the tombstone's alone); no storage credential is given at enrollment (the record's pair is a second sealed record with a presigned address valid at most seven days, and the release is also in the object's header); any enrolled device may put the stored turn packet again so the record outlives two hours with every device off; the snapshot is a multipart stream, since [1002](1002-s3-storage.md) bounds an object and allows only `backups/` and `hold/` names today; a local file can be the carrier.
- **Incremental handoff (phase 3).** A change number on every store write, markers for deletions, a base and a lineage per device pair, and a digest over (store, key, change number), falling back to a full copy on any mismatch. Phase 1 already skips files by digest, which is most of the bytes; phase 3 removes the rest.

## Wallets

Wallets move with the profile, Testnet first, wallet type by wallet type. One rule holds for all of them:

**A wallet's SDK database has one writer in the world.** It is opened by the active device only, after a good turn read under 60 seconds old, on every network (a Testnet federation or a regtest Spark wallet breaks from two writers as a Mainnet one does). A frozen copy of it is never opened: it is replaced by the copy that arrives, rebuilt by the provider's recovery, or deleted.

A wallet type is in one of three classes in a given release:

- **Moves**: its secrets and database travel in pass 2 and the taker opens it.
- **Stays home**: see [Wallets that stay home](#wallets-that-stay-home).
- A type starts as "stays home" on Mainnet and becomes "moves" there when both of its tests pass on Testnet: move there and back with the balance conserved, and a forced takeover from an old copy with the result this table states.

| Provider | Phase 1 | Rule in a handoff | Cost of a double-active window | Rule in a forced takeover or restore |
|---|---|---|---|---|
| **Cashu** | Moves | Proofs, pending melts (with reserved proofs and blank outputs), mint quotes and history move exactly once. Quiesce drains the per-mint lock first: `createToken`, the split before a melt and `receiveToken` swap at the mint before any local write and save no outputs, so they must end, not be cut (`packages/browser/src/engine/wallet.ts`). The standby writes nothing into its frozen copy: that every proof in it has moved follows from the device state, not from a mark | Both spend the same proofs: the second spend fails at the mint, which can break a payment a contact was promised. Change or received ecash that exists only on a device that is later wiped is lost | Because the copy is a frozen one, every proof in it is checked at the mint before it counts (new work); spent ones are dropped. Ecash the lost device received after its last release is gone unless that device comes back |
| **Ark via Arkade** | Moves, once the move test passes; until then stays home | The phrase and the database (`ghostly-ark-<wallet id>`) move whole, under a new local name | Two copies sign from the same coins and disagree about renewals | The stale database is what a restored backup has today, with the same open risk ([202](202-arkade.md) lists stale copies as an open gate). Needs the provider's word; until then a forced takeover parks the wallet as "Needs your decision" |
| **Ark via Bark** | **Stays home** in phase 1 | When it moves (phase 2): both databases move by a database snapshot taken after the SDK has stopped, imported before the SDK first opens that name; refused on a pin mismatch and **while an exit or a round is pending** (the 30 seconds of quiesce are shorter than a round) | As Arkade. An exit in progress needs this device's database | The server's recovery scan runs when a wallet is opened on an empty database (the SDK's default, by the review's reading of its source; the SDK is not in this tree to confirm). The on-chain scan runs only for a typed phrase (`packages/browser/src/engine/paymentAdapters/bark.ts`) and would have to run here too. A send's outcome is found by a movement id that exists only in the old database, so an `unknown` attempt never resolves on a fresh one: it is parked for the person |
| **Fedimint** | **Stays home** in phase 1 | When it moves: the client file is copied byte for byte at the same client build, after the worker releases its handle; otherwise recovery from the guardians | Two clients on one phrase collide on keys ("never joined fresh twice with one mnemonic", [207 Fedimint](207-fedimint.md)) | Never open the old file: join with recovery. Whether the SDK backs up to the guardians by itself is unconfirmed, and recovery of a real profile is not yet exercised. A **Take over** from a restore while another device is alive would be a second join by one button: the SDK stays closed until a good turn read says this device is active |
| **Spark and the Breez Lightning source** | Moves (phrase and API key; the database is rebuilt from the operators) | The releasing device **deletes its Breez database** once the handoff is done: the database is named from the profile and the phrase (`breezDatabase`, the one helper that gives the name, read for a handoff without claiming anything through `breezDatabaseInUse`, and `dropBreezDatabase`, which deletes every database the SDK keeps under it: `<name>/<network>/<identity>` and its `-tree`), so a device that became active again would reopen a stale one | "Two SDK instances over one seed disagree about the leaves" ([206 Spark](206-spark.md)) | Opens from the phrase and syncs. An unfinished send is looked up by its idempotency key, which is in the journal; an attempt the journal does not have cannot be found and is parked |
| **Lightning via NWC, Core Lightning** | Moves | The credential and the journal move. An outgoing payment left `sending` becomes `unknown` and is only looked up | No funds at risk from two readers; two journals diverge | The same. The node's own history is the truth |
| **Lightning via LND** | Moves when the card has no pinned certificate. **A card with a certificate stays home** on anything but a Desktop | The pin is enforced only by the Desktop's Rust transport; on the web the certificate is checked for format and then ignored (`lnd.ts`), so a moved card would run unpinned on a phone | As above | As above |
| **Bitcoin Core** | Stays home (Desktop only) | n/a | n/a | n/a |
| **WebLN** | Nothing moves: it is the browser's own provider | n/a | n/a | n/a |
| **Lightning addresses, another wallet** ([205](205-lnurl.md)) | Nothing is stored | n/a | n/a | n/a |
| **On-chain (BDK)**, Testnet only today | Moves | Phrase, public changeset and coin reservations move | Two spends of one coin: the chain takes one. A failed payment, no loss | The stored `scanned` flag is reset so the wallet does a full scan: a frozen copy with `scanned: true` never rescans and would hand out used addresses (`bdk.ts`). Reservations are dropped; a saved signed transaction is parked, not broadcast |
| **USDT** | **Stays home** in phase 1 | When it moves: seed and journal move exactly; the journal holds the only nonce guard (`persistence.ts`) | Two transactions at one nonce | Saved signed bytes are **never broadcast again**. Without the journal nothing guards the nonce, so sending stays off until the person confirms the account's last transaction on chain |

Since a new profile gets Mainnet Cashu and USDT by itself, the phone in phase 1 has ecash and remote Lightning, and shows USDT as "On <device>".

### Wallets that stay home

A wallet that stays home has a **home device**: the one where its SDK database lives.

- Its record (with its sealed phrase) moves with the profile like any setting, marked with its home. Its database does not move, and no other device opens the wallet. So the single-writer rule holds trivially: the only copy of the database is opened only by its home, and only while home is active.
- On another device its card shows "On <device>" and "<wallet> can't be used here. Use it on <device>."
- **Coins that expire.** Ark and Bark coins must be renewed while the app is open (Bark: coins live 4,032 blocks, about 28 days, and are refreshed from 264 blocks before the end, `barkSdk.ts`; an expired coin can be swept, [204](204-bark.md)). A wallet at home on a standby is not renewed. So: the card and the handoff screen show "Coins expire on <date>. Use Ghostly on <device> before then."; a handoff away from home is refused when the earliest expiry is under 3 days away ("Renew your <wallet> coins first"), with no override; and the active device reminds the person 7 and 3 days before.
- If the home device is lost, a forced takeover recovers the wallet from its phrase by its row above, with that row's losses.

### Payments in flight

One rule per path.

**A handoff** (the active device is alive and can settle its own business):

| In flight | What the handoff does |
|---|---|
| A payment being executed (an attempt `submitted` whose call has not returned), a Cashu swap inside its per-mint lock, a Bark round, an exit | The handoff waits up to 30 seconds, then answers "A payment is still going through. Try again in a moment." Wallet removal refuses in the same case today (`node.ts`) |
| A review not yet approved | Cancelled on the old device, which releases its reserved coins. Nothing `pending` moves |
| A payment `submitted` or `unknown` at rest | Moves as it is and is only looked up on the new device; nothing that moved may authorize a new send ([200](200-payments.md)) |
| A Cashu melt awaiting the Lightning result | Moves with its reserved proofs and blank outputs; the new device polls it |
| A reviewed Cashu swap with saved outputs | Moves; the new device recovers those exact outputs from the mint or proves the swap never happened |
| Our Lightning invoice (a mint quote, a Lightning card's open invoice) | Moves; the new device watches it. A payer who pays during the gap loses nothing: the money waits at the mint or node |
| A held test-mint quote | Moves as held: still never minted until the payer vouches, still deleted 60 seconds after it expires |
| A payment request of ours open in a chat | Moves with the chat. One with a short-lived target (15 minutes for Ark and Spark) may expire during the handoff and is then closed as expired |
| A contact's request to us, not paid yet | Moves with the chat; paying it is a new review |
| Ecash a contact sends during the gap | Ecash is never held ([404](404-store-and-forward.md)); it needs a live session, so the contact's app waits |
| A file transfer with a contact | Stops at its last checkpoint and resumes from the new device |

**A forced takeover or a restore** (the old device cannot be asked): `pending` becomes `unknown`, as a restore does today; nothing is cancelled, because nothing can be known; saved signed bytes are parked. See [Forced takeover](#forced-takeover).

## User experience

Copy follows the app's rules: short labels, one-line hints, details behind ⓘ. `<device>` is a device's name. Devices live on the **Profile page, beside Backups** (`apps/ui/src/pages/Profile.tsx`). The app has no first-run screen today, so "I already use Ghostly" is new UI and part of the phase.

**Profile, Devices**

- Title: "Devices". Hint: "Use this profile on another device. One device is active at a time." ⓘ: "Only the active device sends, receives and pays, so your messages and money are never in two places. Move the profile whenever you like."
- Rows: name, kind icon, and one of "This device · Active", "Standby", "Standby · no copy here", "Not finished". Row menu: "Move to <device>" (on the active device, for a device that is on), "Rename", "Remove".
- Buttons: "Add a device". On a Desktop with a standby device: a switch "Keep this computer awake", hint "So your phone can take over while you are out."

**Adding a device**

- One dialog, "Add a device". Without a lock password of 8 characters it asks inline first: "Set a password first", ⓘ "Without a password, anyone holding one of your devices can take this profile." (or "Type your lock password", "Choose a longer password", each with its reason behind ⓘ).
- Active device, after the password: "Scan this with your phone's camera." ⓘ "On a computer, open Ghostly and choose Add this device to another profile, then scan or paste the code. It works once, for 10 minutes." QR code, "Copy link", and under it where it stands, as it changes: "Waiting for your other device…", "A device is connecting…", with "9:41 left" in small type; then "Found <device>. Check that it shows the same digits." with the digits, "They match" and "They don't match"; then "Adding <device>…" and "<device> added. It is on standby." An enrollment that ends says why in one line, with "Try again", which makes a new code.
- New device, first screen: "I already use Ghostly" (on the chat list of a new profile, where a phone shows it, and the home pane), then "Add this device to my profile" (the scanner) or "Restore a backup".
- New device that has a profile: "Add this device to another profile" in the profile switcher and the profile list, and on Profile, Devices while the profile has no other device: "Use this device with a profile from another device". It opens the scanner.
- New device, the one screen every code ends on: "Add this phone to <profile>" ("tablet", "computer"; "to your profile" when the link names none), "Name this device" prefilled ("Phone", "Mac app", "Firefox on Mac"; 16 characters), and one button, "Add". In a profile that holds something it says "Ghostly makes a new profile here for it. Your profile here stays as it is." ⓘ "The profile on this device has chats, groups or money, so it can't become a copy of the other one. Switch between them in the profile menu."
- New device, then: "Connecting to your other device…" (or "Getting ready…" while a new profile's wallets load), "Check that your other device shows the same digits." with the digits and "Confirm on your other device.", then "This device is on standby for your profile." and the standby screen opens by itself. A failure says why with "Scan a new code".
- On iPhone and iPad in a Safari tab: "Add Ghostly to your Home Screen first", one line "Your profile needs the app, not a Safari tab." (ⓘ the storage reason), and three steps: "Tap Share in Safari.", "Tap Add to Home Screen.", "Open Ghostly from your Home Screen and scan the code again." (or "and choose I already use Ghostly." when no code was read). The app on the Home Screen has storage of its own and opens at its start page, so the code does not go with it.
- Where the browser did not grant persistent storage: "This browser may clear Ghostly's data. Keep a copy on <device>.", with "Continue".
- Done, new device: the standby screen with "Bring my profile here now · 480 MB".

**What a standby shows**, the whole profile area, behind the lock screen:

| Device state | Title | Hint | Buttons |
|---|---|---|---|
| `standby`, turn read `other` | "Active on <device>" | "Moves this profile from <device>." | "Use here"; link "My other device is lost or broken" |
| `standby`, read `unreachable` | "Can't check which device is active" | "Check your connection." | "Try again" |
| `standby`, with an offer from the active device | "Move this profile here from <device>?" | "About 480 MB." | "Use here", "Not now" |
| `standby`, the other app is newer | "This profile was last used by a newer version of Ghostly." | "Update the app to open it." | "Check for updates" |
| `releasing` | "Moving to <device>" | "Nothing changes until the last step." | "Cancel" |
| `standby`, just released, no `handoff-done` | "Moving to <device>. Waiting for it to finish." | "Open Ghostly on <device>." | "Use here" (reads the turn first) |
| `taking`, settling | "Checking which device is active" | "About 30 seconds." | none |
| `taking`, no source answers | "Finishing" | "Waiting for the network." | none |
| Any state, turn read `closed` | "Something else closed your device set" | On the active device: "Make a new device secret to go on." Elsewhere: "Open Ghostly on <device>." | On the active device: "New device secret" |
| The device state cannot be read | "Can't read this device's state" | "Nothing was started." | "Try again" |
| `superseded` | "This device was replaced" | "<device> took over without this one. This device has stopped." | "Use here", "It wasn't me"; a line "3 messages and 1 payment are only on this device" |
| `moving` | "Almost there" | "Open Ghostly on <device> to finish." | link "My other device is lost or broken" |
| `moving`, no `set-update` it can accept | "Your devices changed while this one was off" | "Add this device again from the device you use now." | "Add this device to my profile" |
| After a `set-update` was accepted, once | "Your devices are now: <names>" | "If this list looks wrong, do not use this device." | "OK", "This is wrong" (stays out and asks for enrollment) |
| `removed` | "This device was removed" | "Add it again from <device>." | "Remove this profile here" |
| Enrollment not finished | "Not finished" | "Start again on <device>." | "Remove" |

ⓘ on the standby screen: "Only one device sends, receives and pays at a time, so your messages and money are never in two places."

The account switcher ([04](04-profiles.md)) shows such a profile with the word "Standby" in place of its unread count.

**Handoff progress** (on both devices)

- Title: "Moving your profile". Steps: "Connecting to <device>", "Copying files · 120 of 480 MB · 4 min" (with, on the active device, "You can keep using Ghostly"), "Getting ready", "Copying the rest", "Checking", "Switching", "Checking which device is active · about 30 seconds".
- "Cancel". Hint: "Nothing changes until the last step."
- The last step is the settle wait. It is new with this revision and it is on every switch: for about 30 seconds neither device is active. ⓘ there: "Ghostly waits to be sure no other device took over at the same moment."
- On mobile data, before the copy: "Uses about 480 MB of mobile data." with "Continue", "Later", and a switch "Bring large files later", on by default there (files over 16 MiB).
- On a phone: "Keep Ghostly open."
- Done, new device: the app, with a notice "This device is now active." Done, old device: the standby screen.

**Failures**

| When | Copy |
|---|---|
| The other device does not answer | "Can't reach <device>. It must be on, with Ghostly open." |
| The other device is a phone | "Open Ghostly on <device> and keep it open." (a wake push was sent) |
| Wrong lock password | "Wrong password." After the limit: "Too many tries. Unlock <device> to try again." |
| The link dropped | "Stopped at 60%. It resumes when both devices are online." with "Resume" and "Cancel" |
| Nothing from the other device for 2 minutes, during the copy | "The move stopped: no answer from <device> for 2 minutes. Nothing changed, and files already copied are kept." on both devices, with "Try again" (on the standby, Use here again; on the active device, the move offered to that device). The device that had the profile still has it |
| A part failed its check | "The copy was damaged. Nothing changed." with "Try again" |
| No room | "Not enough space on this device: 1.2 GB needed." |
| Older app on the taking device | "Update Ghostly on this device first." |
| A payment is running | "A payment is still going through. Try again in a moment." |
| A handoff is already running | "Another move is in progress." |
| A wallet that stays home | "<wallet> can't be used here. Use it on <device>." and, for Ark and Bark, "Coins expire on <date>. Use Ghostly on <device> before then." (a notice, not a failure) |
| Coins about to expire | "Renew your <wallet> coins first." |
| The turn cannot be read | "Can't check which device is active. Check your connection." |
| The taking device's settle read, not within 2 minutes | "Can't check which device is active. Check your connection, then try again." with "Try again" |

**Forced takeover**

- "Take over without <device>?" One line: "This device has your profile as of <date>." ⓘ: "Messages and money that reached <device> after that are not here. If <device> comes back, it stops." and one line per wallet ("Cashu: 12 000 sats here, checked with the mint when you take over").
- "Lost or stolen?" with "Lost or stolen" and "Just broken or wiped". On the first, after the takeover: the money checklist, then "Remove <device>".
- The person types the device's name to confirm. Button: "Take over". Then "Checking which device is active", about 30 seconds, before the profile opens.

**Remove**

- "Remove <device>?" Text: "It can no longer take this profile." If it held a copy: "It still holds your chats and wallets as of <date>, unencrypted." Buttons: "Remove", and "Lost or stolen" (the checklist first).

**Restore where a device set exists**

- "This profile is active on <device>". Buttons: "Add this device instead", "Take over", "Cancel".

**What contacts see.** Nothing that says "device". They see what an app that closed and opened again shows: the chat goes offline and comes back. During the gap of a handoff, calls and payments to the person are off with the words their app already has. They can infer a change of device from what already differs between clients: the transports and capabilities in the capability record (a phone's web app lists fewer than a Desktop), another network address. After a forced takeover they may see the two lines named in [Raised counters](#raised-counters).

### Push and the phone

The phone is the installed web app ([docs/WEB.md](../WEB.md)).

- **The phone's push target survives a switch.** A contact holds one target per chat and learns it only on a live session, and a desktop has none of its own, so today a desktop coming home would clear the phone's (`w: null`) and a contact who was offline could never wake the phone again. Instead, the description of the phone's target (endpoint, keys, the per-chat tokens) moves with the profile, and an active device with no subscription of its own goes on giving contacts the phone's, with the unchanged `paired-wake` frame. When the phone is active again, contacts already hold its target.
- **A subscription that changes on a standby.** A browser may replace a push subscription at any time. A standby whose subscription changed tells the active device over the device link when they next meet, and the active device hands out the new description; until then contacts hold a target that answers 404 or 410 and forget it, as today.
- **A standby phone never rings.** A push that reaches a standby shows "New message. Active on <device>." or, for a call, "Call for you. Active on <device>.", quietly: no ring, no vibration pattern, no notice that stays up. A tap opens the standby screen. The caller sees today's "<name> did not open Ghostly." after its wait; the standby cannot answer, and the notice tells the person where to.
- **The device link can wake a phone.** Each device with a push subscription shares its target with the person's other devices in a `device-wake` frame on the device link, with a token of its own. A desktop asking a suspended phone for a handoff posts a push to it, body `{"wake":1,"k":"<token>","d":1}`, sent as a wake-up to a contact is ([401](401-paired-chat.md#wake-up-push)); the worker shows "<device> wants to take over. Open Ghostly."
- **How the worker knows.** It reads the device state from the `ghostly-devices` database when a push arrives: `active` shows today's notices; any other state shows the standby ones, with the active device's name from the stored device set.
- **Storage.** On iPhone and iPad the Home Screen install gates enrollment. Elsewhere a refused `persist()` is a warning, not a stop. If a phone's storage is cleared while it is active, the frozen copy on the other device and a forced takeover are the recovery, which is why phase 1 always keeps one.
- **Background.** A phone suspends the web app in the background, so a handoff runs with the app in front (a screen wake lock, "Keep Ghostly open"). Pass 1 resumes after an interruption.
- **Platform floor.** Push needs iOS 16.4; a non-extractable device signing key needs Safari 17. Below that the device signing key is a stored seed.

## Security and privacy

### Threats

| Threat | What limits it | What remains |
|---|---|---|
| A stolen standby with a frozen copy | The device's own lock and disk encryption. Removal closes the turn and the device links to it | **The copy is not encrypted by Ghostly**: seeds are sealed with a key stored beside them ([202](202-arkade.md), persistence), and the lock password is a screen gate. Everything in the copy is readable and usable until money is moved and chats are paired again |
| A stolen standby with no copy | It holds `D` and a device signing key, nothing of the profile. A pull needs the lock password: 5 tries an hour, 15 in all | A weak password guessed within the limit. The device names in the turn record |
| A few minutes at the unlocked active device | Adding a device asks for the lock password; the digits must be confirmed there; every device shows the device list; a new device raises a notice on the active one for a day | With the password known to the attacker, an enrolled device that can pull later. A backup export has the same reach, once |
| A holder of a backup made **before** enrollment | None until a device is removed: the first `D` comes from the DID seed, which every older bundle holds. So every bundle ever made of the profile can read the turn record and take the turn | It could already start the whole profile as a second copy; what is new is that it can also stop the honest devices. Removing a device, or "New device secret" on the Devices page (the same steps with nobody removed), moves the set to a random `D` that no older bundle holds |
| A holder of a backup made after enrollment | It has `D`: it can read the turn record and take over | By design: a backup is the profile. Removal moves the set to a new `D`, after which that bundle can only start a separate copy |
| A relay operator hides or replays the turn record | A lower sequence cannot replace a higher one on an honest node; Desktop also reads the DHT. A sequence a relay only reports, with no signed packet, counts for nothing: a relay cannot close the address or push a device into the next turn | Web and extension read one operator by default. A device that is shown only old records is not told it was replaced, and a settle read that is shown only the device's own record lets it start |
| Two devices raise the turn at once, through relays | Relays refuse nothing but a lower sequence (`If-Match` is ignored), so both puts can be stored. Each device waits `T` after its put and reads every source again, and starts only on `mine` | A put that needs longer than `V` to show, or a relay that answers from its cache: both start, and the lower sequence stops at its next read, up to about 10 minutes |
| A holder of `D` closes the address with a packet at or above 2^52 - 1 | No device takes it as a good read, so none acts on it; the active device moves the set to a new `D`, delivered over the old links | The honest devices are stopped for the profile's network work until the person reacts |
| A photographed enrollment code | One session per invite; digits only after the inviter's proof; the code holds no long-lived secret (links are derived from `D`) | The attacker can make the person's own attempt fail; the person starts again |
| A hostile holder of `D` raises the turn or replaces the tombstone | Shown on every device as taken without a release; "It wasn't me" takes it back and moves to a new `D`. A forged tombstone can only send a device to a state that does nothing | The honest device is stopped until the person reacts; a staying device may need one new enrollment |
| A removed device hands a `moving` device a secret of its own | A `set-update` counts only when signed by the device the receiver's stored record names active and the tombstone still lists; the new device list is shown once | A device that was off across a takeover and whose stored active device is the hostile one |
| Cloned storage | A record from the device's own slot that it did not store | A window until the copy that did not write last reads |
| A contact claims a higher turn | Hints only trigger a read | None |
| Power loss right after a release | Strict durable writes; the Desktop's fsynced file | An engine that reports a strict commit it did not flush (to be measured) |

### What an observer of the DHT learns

- **The turn key** is derived from `D` and appears nowhere else. For the first `D` it is derived from the DID key's seed, which is secret: knowing the public DID does not give the address. An observer links it to a profile only by the address that publishes it, which also publishes the chats' records.
- **The record** is sealed and has one size: its content, the number of devices and their names are not visible. Its label is neutral, but its size and its sequence, which is not a clock time, mark it as a turn record to anyone who knows this document.
- **The sequence number is in the clear.** Someone watching that key sees it rise by 2^20 at every handoff: the count and times of the switches since they started watching (the start is random). Smaller steps are `rev` changes and engine starts.
- **A switch changes the publishing address** for the turn record and for every chat record at once, as a move to another network does.
- **Device links** publish rendezvous records under keys derived from `D` while the apps are open: one more pair of keys per pair of devices at those addresses.

### Before phase 1 ships: the tests that must exist

Unit and engine:

- the record's bytes, test vectors that pin the canonical packet for both writers, every refusal of the reader, the sequence formula, the tombstone; a packet cut another way still reads;
- the read algorithm against sources that disagree, lag, refuse and time out; a refused put is never sent again to that source or without its condition; a sequence a relay reports without a signed packet moves nothing; a DHT lookup that finds nothing is that source not answering; Desktop puts to no relay when the DHT refused;
- **the settle rule against a relay that ignores `If-Match`**: two and three devices raising one turn, every put order and both slot orders, relays only and Desktop mixed with web: at most one writes `active`; a put later than `P` after its read is not sent; a restart during the wait waits again; a settle read that a source did not answer starts nothing;
- `closed`: no state acts on it, and each exit works; a `superseded` and a `moving` device that read their own old packet stay;
- the handoff state machine with a kill at every step on each side, covering every row of the crash matrix, and **power loss** after the release write;
- an equal-sequence record from a clone;
- the password proof: wrong password, the attempt limits, a replayed message;
- enrollment: a second joiner, a wrong proof, digits withheld until the proof, an invite past its time, an old app given a version 2 code;
- the gate: a standby starts no wallet, publishes no DID or proof record, reads no mailbox, and is skipped by profile peek, on web, extension (browser start with no page, in the offscreen document) and Desktop; a state that cannot be read starts nothing when a device set is in evidence and starts the profile when none is; the two Desktop copies in every pair of states;
- raised counters across a group epoch change and a new community head; edits and pins untouched;
- a stale admin: after a forced takeover a member's leave produces no commit, and door duty is refused;
- a stale USDT attempt is not broadcast after a forced takeover or a restore; a stale BDK copy rescans;
- a stale Breez database is gone after a release and a return;
- an old build opening storage written by this version shows the newer-version notice and starts nothing;
- a bundle made before enrollment, restored in this version, finds the record; a bundle with a device set and no record on the network is not started;
- removal: a kill at each of its five steps; a staying device that was off becomes `moving` and takes the signed frame from the remover and, forwarded, from a third device; a `set-update` signed by the removed device, by an unlisted key or by nobody is refused; a forged tombstone leads to enrollment and nothing else; two `moving` devices that both start their own set end with one running; the tombstones and the frame survive a handoff;
- a third device forces the turn a taker holds a release for: the taker yields when a read shows it the other record, in either slot order; when it never sees it (its higher sequence replaced it), the forcing device reads `other`; one device is active in every order;
- an invalid record with a high `rev` does not block the active device's next put; `behind` ends after three rounds.

End to end:

- two browser contexts as two devices plus a contact: enroll, pull, push, cancel at each step, resume after a dropped link;
- Desktop to web and back, with files over 64 MiB and a file left for later;
- partitioned relays (each device sees a different relay) during a forced takeover, and two devices forcing the same turn through two different public relays, which also measures `V`;
- for each wallet type that moves: a funded Testnet wallet there and back with the balance conserved, and a forced takeover from an old copy with the result its row states;
- a soak, before any Mainnet wallet moves: two devices switch back and forth a few hundred times while a contact and a group send messages, files and Testnet payments; at the end no message is lost or doubled, balances add up, every counter a contact saw only grew, and the relay log shows one writer per record at a time.

And: a security review of the implementation ([docs/SECURITY-REVIEW.md](../SECURITY-REVIEW.md)) before the release, and the measurements of [Measured, and still to measure](#measured-and-still-to-measure) written into this document.

## Compatibility and rollout

**Contacts, on any version.** No frame, record or capability of a chat or a group changes. A handoff looks like an app that restarted. A contact on 1.0.x sees, after a forced takeover only, the hold line and the missing-frame count of [Raised counters](#raised-counters), once.

**Old app versions on the person's own devices.**

- An older build must never start a frozen copy. **The first part that lets a device hold a frozen copy raises `DB_VERSION`** (`packages/browser/src/shared/idb.ts`) above whatever `dev` holds then, so an older build that opens that storage gets a version error, shows the newer-version notice and starts nothing. The released 1.0.3 has 12; devices raise it to 13, a step with no change of the schema. The first part as built (the device state and the gate) did not raise it: nothing in it can freeze a copy, and no device can be enrolled yet. The handoff keeps the files a frozen copy holds by digest in the device record, not in an index on the files store, so it needs no schema step of its own. The Desktop's own files carry no version, so there is nothing to raise there: an older Desktop build is stopped by the database's version, as on the web, before it reads a file. The device state file has a version field of its own, which Rust checks.
- A bundle that carries a device set has **envelope version 3** (WISP 05's streamed bundle took 2 first; every other bundle is 2, a light one included, whose mark is in its `profile` record). The envelope check is the strict one ("This backup comes from a newer Ghostly; update to restore it", `packages/browser/src/backup/envelope.ts`); a higher payload version would answer "does not hold a profile".
- A bundle made **before** enrollment has envelope version 1 and no device set. An app with this WISP still guards it, through the `D` derived from the DID key. **An app from before cannot be stopped** from restoring it as a live second copy; that is today's risk, unchanged, and the client says so when a device set is made: "Backups made before today can still start a second copy in an older Ghostly."
- Enrollment codes are a new invite version, which an older app must refuse.

**Record and wire changes, all additive.**

| Change | Who sees it |
|---|---|
| A new Pkarr record under a new key, with a counter as its sequence number | The person's devices, relays and DHT nodes |
| Device links: ordinary paired sessions on derived keys, with capabilities `enroll/1` and `handoff/1` and their frames | The person's devices only |
| Invite version 2 | The person's devices only |
| The backup envelope version 3 when a device set is inside; never a device signing key | Backups |
| The `ghostly-devices` database (and the Desktop's state file); `DB_VERSION` raised by the first part that can freeze a copy; an index on the files store by digest, as a version step of its own | One device |
| A turn path of its own in the relay client (every relay, `NetworkOnly`); on Desktop a Mainline node of the turn's own, for a put with `cas` | Code only; relays see `NetworkOnly` reads |
| Phase 2: a `handoff/` folder and a multipart object in the storage layout ([1000](1000-storage.md)) | The person's storage |

### Phase 1 (targets 1.1)

Phase 1 is the daily story: the desktop at home, the phone outside, both able to be on at the moment of the switch. It contains, as pieces that can each be a pull request:

1. **Device state and the gate.** The `ghostly-devices` database with strict writes (and the Desktop's fsynced file); the gate in front of `start()` on web, extension (the offscreen document) and Desktop; device-link-only mode; profile peek skipping standbys; the rule for a state that cannot be read. Built, on `dev` since #1118. Left from it: the `releasing` read-only exception (with the handoff), the push worker reading the state, the lock's attempt counter moved out of the profile's keys.
2. **The turn record.** The binary codec with vectors; the reader; the put that names a sequence per source and the read of every source with `NetworkOnly`, in TypeScript and in the Desktop's Rust (`cas` on a Mainline node of its own); the checks and limited mode; `instance` and clone detection. Built, on `dev` since #1118. This revision asks of it: the settle wait, a mark moved only by verified packets, `closed` as no good read, the canonical packet in the Rust writer, the DHT before the relays on Desktop, the node built at start and its miss as `unreachable`.
3. **Device signing keys and derived links.** Non-extractable where it exists, a seed elsewhere; link derivation; device signing keys as participation keys with trust on first use off; the signer interface in `PairedSession`.
4. **Enrollment.** Invite version 2; `enroll/1`; the digits; the 8-character lock password; the iOS install gate and the `persist()` warning; the first-run "I already use Ghostly" screen.
5. **The handoff.** `handoff/1`; pull and push; the password proof and its limits; two passes; skip by digest (the new index, a version step); files left for later and fetched over the device link; staging and install (the device record under both names); `DB_VERSION` raised; the settle wait as the last step; the crash matrix; versions in the first frame; the progress and failure screens.
6. **Forced takeover and the restore guard.** Raised counters and the group floor; admin work off; signed bytes parked; the BDK rescan; the first `D` from the DID key; envelope version 3; the superseded screen.
7. **Remove a device.** The new `D`, its delivery over the old links (`set-update`, `set-ack`, the pending list), the tombstone and the `moving` state, "New device secret", the signed frame and its forwarding, the read-back before a `moving` device starts a set of its own, the "Lost or stolen?" checklist with the storage keys line.
8. **Wallets.** The single-writer rule behind a fresh turn read; Cashu's lock drain and the proof check after a takeover; Spark's database deleted on release; home devices, the "On <device>" cards and the expiry dates and refusals; the per-type Testnet tests.
9. **Push.** The phone's target kept by the active device; the standby worker's quiet notices; the wake push over the device link; "Keep this computer awake" on Desktop.
10. **Devices on the Profile page**, the standby screens and the switcher's "Standby".

**Moves in phase 1:** chats, messages, files, groups, identities, the DID, settings, storage settings, and these wallets: Cashu, Spark, Lightning through NWC and Core Lightning, LND without a pinned certificate, on-chain BDK (Testnet only as today), and Arkade once its move test passes. Testnet wallets of these types move from the first release; a Mainnet wallet of a type moves once that type's two tests pass and the soak has run.

**Stays home in phase 1:** Bark, Fedimint, USDT, LND with a pinned certificate, Bitcoin Core, and Arkade until tested.

**Honest limits of phase 1:**

- Both devices must be on, with Ghostly open, at the switch. A desktop asleep at home cannot hand over; "Keep this computer awake" and "Move to <device>" at the door are the ways around it. There is no pickup from storage yet.
- Every switch and every takeover ends with about half a minute in which no device is active, while the taking device checks that no other device took the turn. The number rests on a time that is not measured yet.
- With web apps and extensions only, two devices that take the turn in the same seconds are kept apart by that wait and not by a refusal. If the network is slower than assumed, both run until the next check, up to about 10 minutes.
- The first move to a device copies every file. Later moves copy only new files and the database.
- A pull asks for the lock password every time.
- A frozen copy is kept on every device that was active, unencrypted. A lost phone means Remove, the money checklist and pairing chats again.
- After a forced takeover, what only the lost device had is not here, groups are not managed from the new device until the person says so, and a payment that was signed but not confirmed waits for a decision.
- Some wallets stay on the desktop, and Ark or Bark coins there need the desktop to be the active device every few weeks.
- A device that cannot read the turn record does not start by itself, and "Start anyway" gives the profile offline only: history and settings, and no message to a contact, as when the app is offline today. With both default relays down, a web or extension device cannot send until one answers.
- CLI profiles are not part of it.

### Later phases

| Phase | What it gives |
|---|---|
| 2 | Prepared handoff naming its taker, through S3-compatible storage or a local file; "Keep no copy here"; "Send what is only here"; the guided money flow; Bark, Fedimint and USDT moving as their tests pass; `ghostly device` commands for moving a CLI profile between servers, if still wanted |
| 3 | Incremental handoff by change numbers |
| 4 (optional) | Contacts refuse a superseded device; participation-key rotation ([02](02-peer-keys.md)) |

## Why not two live devices

It is the natural next wish, so the reasons are written down. Two live devices need: a device signing key per chat known to each contact, so the contact can send to both and tell them apart (every chat record and the session handshake change, and old contacts cannot follow); delivery of each message to every device, with no server to fan it out; group counters and admin commits per device; and wallets with two writers, which Cashu proofs, Fedimint clients and Spark leaves do not allow. One active device with a handoff needs none of that and keeps every existing format.

## Decisions and open questions

**Settled by the two reviews** (the three defaults proposed to the owner stand):

| Question | Answer |
|---|---|
| Handoff while the active device is off | Phase 2, and it names its taker. Phase 1 is both devices online, with "Move to <device>" for leaving home |
| Do wallets move | Yes, under the turn, Testnet first, type by type. Bark, Fedimint, USDT and pinned LND stay home in phase 1 |
| When | Phase 1 targets 1.1 |
| Does a standby keep a copy | Yes, always, in phase 1 (changed from "nothing on a phone": that made every departure a full copy and left one copy of the profile in the world). "Keep no copy here" is phase 2 |
| A standby phone still woken by push | Yes: the active device keeps the phone's target with contacts; a standby never rings |
| A lock password to have a second device | Required, 8 characters |
| CLI profiles as devices | No. CLI profiles are `single`; no `ghostly device` commands in phase 1 |
| How many devices | 4, with a binary record |
| Device links | Derived from `D` and the device signing keys |

**Still open, for the owner:**

1. **Mainnet money.** The rule above lets a wallet type move on Mainnet once its two Testnet tests and the soak pass. Recommendation: keep that rule, and let the owner say go per type; the first release may well ship with Mainnet Cashu and remote Lightning only.
2. **"Start anyway" when the turn cannot be read.** It now opens the profile offline only: nothing is published, dialled or settled before a good read, and a message to a contact is refused, so it costs no safety. The open part is whether it should later do more (live sessions with contacts while the relays are down), which would bring back a double-active window for messages. Recommendation: not in phase 1.
3. **A turn record for every profile, even with one device.** It costs one more key and one hourly put per profile, and it would let a restored backup always find out that the original still runs. Recommendation: yes, in phase 2, once the record has run in the field.
4. **Readable history on a standby.** Recommendation: not yet. It is useful, but every screen that reads history would need proof that it starts nothing, and the gate's strength in phase 1 is that a standby opens no profile database at all (only a `releasing` device does, read-only, to send it).
5. **Participation-key rotation** as its own WISP. It is the real answer to a lost device that held a copy. Recommendation: design it alongside phase 2.
6. **The settle wait.** 30 seconds on every switch is the price of relays that refuse nothing. It can shrink once `V` is measured. A relay that honoured `If-Match`, or a device set whose every device reaches the DHT itself, would bring back a refusal for unequal sequences, and the wait could then be shorter for them. Recommendation: keep one rule for every device in phase 1, measure `V` before the handoff is built, and set `T` from it.

## Conformance (candidate)

A client that implements this WISP MUST:

- keep a device signing key that is in no backup and no handoff;
- read the device state before starting anything, and in any state but `single` and `active` open no profile database (a `releasing` device excepted, read-only, for pass 2) and publish nothing but the turn record and device-link rendezvous; when the state cannot be read, start nothing if a device set is in evidence;
- write `standby` with strict durability before it signs a release to another device (a release to itself, when `rev` runs out, excepted), and name the taker in every release;
- start as active, after raising the turn, only with a verified state and a stored release or after an explicit forced takeover, and in both cases only when a read of every source, made `T` after its put, returns its own stored packet as the highest; send that put within `P` of the read before it;
- use `turn * 2^20 + rev * 4 + author` as the turn record's sequence number and 2^52 - 1 for every tombstone, write the canonical packet, store a packet before putting it, put a stored record byte for byte, name to each source the sequence it held, never repeat a refused put to that source or without its condition, and never take a put that was stored as proof that nobody else wrote;
- treat a record as its own only when a source returns its stored packet, and drop a record whose author is not the device it names active (a tombstone excepted);
- count a sequence as seen only from a packet whose signature it verified under the turn key, never from a number a source reports; take no record below the highest sequence it saw as current; treat `closed` as no good read;
- read the turn with `?policy=NetworkOnly` on every relay; on Desktop put to the DHT first and to relays only when the DHT stored, and count a DHT lookup that finds nothing as that source not answering;
- in limited mode publish, dial and settle nothing before a good read, and refuse what the offline engine refuses;
- take over, after releasing a turn, only at a turn above the one it released;
- read the turn from every source it has, and stop at once on a higher turn, on a record above its own from its own slot that it did not store, or on a tombstone; as a `taking` device, yield to any other valid record at its turn;
- remove a device only as the active device, storing the new secret, the tombstone and the signed `set-update` before any of them leaves; as a `moving` device, accept a `set-update` only when signed by the device its stored record names active and the tombstone still lists, and otherwise wait for enrollment; forward a signed `set-update` unchanged and sign none it did not make;
- on finding its tombstone replaced by another valid one, stop putting its own and tell the person;
- open a single-writer wallet SDK, spend real money, sign a group commit or take door duty only after a good turn read under 60 seconds old;
- after a forced takeover or a restore: raise exactly the listed counters, keep admin work off until the person turns it on, and never broadcast saved signed bytes;
- never open a wallet database it holds as a frozen copy;
- send enrollment and handoff frames on a device link only, admit one session per enrollment invite, and show digits only after the inviter's proof;
- require the lock password for a pull and limit attempts.

## References

[Profiles](04-profiles.md), [backups](05-backups.md), [peer keys](02-peer-keys.md), [invites](800-invite-join.md), [store-and-forward](404-store-and-forward.md), [storage](1000-storage.md), [payments](200-payments.md), [wallets](../WALLETS.md), [DHT delivery](../DHT-DELIVERY.md), [the web app](../WEB.md). [BEP 44](https://www.bittorrent.org/beps/bep_0044.html) for the sequence number and `cas`; [Pkarr](https://pkarr.org); [RFC 9807](https://www.rfc-editor.org/rfc/rfc9807) (OPAQUE).

## Revision log

One file per change in [changes/06-devices/](changes/06-devices/) ([how](00-process.md#revisions)). The site lists them here, newest first, and derives the Revision and Updated rows from them.
