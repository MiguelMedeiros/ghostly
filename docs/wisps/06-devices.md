# WISP 06: One Profile on Several Devices

| Field | Value |
|---|---|
| Candidate number | 06; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [01](01-ghost-core.md), [02](02-peer-keys.md), [03](03-capabilities.md), [04](04-profiles.md), [05](05-backups.md), [200](200-payments.md), [400](400-chat.md), [401](401-paired-chat.md), [403](403-dht-text.md), [4xx store-and-forward](4xx-store-and-forward.md), [501](501-paired-files.md), [800](800-invite-join.md), [900](900-group-sessions.md), [1000](1000-storage.md), [1002](1002-s3-storage.md), [11xx](11xx-headless.md) |
| Implementation | None. A design proposal, revised after two reviews, with phase 1 specified to be built from |
| Summary | Use one profile on a desktop and a phone: one device is active at a time, and one button moves everything to the device in your hand. |
| Availability | Planned |
| Notes | Not built. Phase 1 targets 1.1: web, desktop and extension, both devices online. Two devices live at once, server accounts and background sync are out of scope. |

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
- **CLI profiles.** A profile of the headless CLI ([11xx](11xx-headless.md)) is always `single`: its stored payload is not the app's, and a bot is its own profile and a contact. A bot moves servers with `profile backup` and `profile restore`, as today.

## What exists today (evidence)

The design rests on these facts of the code on `dev`, each checked against the file it names. Where one is wrong, the section that cites it must change.

| Fact | Where |
|---|---|
| There is no profile-wide key and no device identity. Every chat has its own rendezvous seed, invite secret and participation seed, and a seed per native transport. The only profile-wide key is the DID key, which no chat uses and no contact reads routinely | `packages/browser/src/shared/types.ts` (`StoredLink`), [3xx did:dht](3xx-did-dht.md#the-key), `packages/browser/src/engine/did.ts` |
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
| An app that finds a database from a newer version shows "This profile was last used by a newer version of Ghostly." and starts nothing | `apps/ui/src/components/ProfileUnavailable.tsx`, `packages/browser/src/shared/idb.ts` (`DB_VERSION`) |

Four consequences shape everything below.

1. **There is no "profile record" to put the turn in.** The turn needs a key and a record of its own, read by the person's own devices only.
2. **The per-record sequence numbers are no lock.** They are clock time, so a stale device that publishes simply wins. The turn is the only lock.
3. **Moving state breaks no key chain** (nothing ratchets), but **rolling state back is harmful**: a device acting on older counters is dropped silently by contacts, its held items can be settled unread, and an admin doing so can halt a group. The handoff moves counters exactly; the paths that cannot (a forced takeover, a restore) raise them and switch admin work off.
4. **A standby is not silent with today's start order.** The gate has to sit in front of everything `start()` does, on every client.

## Measured, and still to measure

Two reviews ran experiments. Their results are used below as facts, with these limits.

| Measured | Result | Limit |
|---|---|---|
| BEP44 puts against a 6-node local `mainline` 8.0.0 testnet | A lower sequence is refused (error 302). A **different packet at an equal sequence is accepted and replaces the first**. A put with `cas` is refused on a mismatch (301) and stored on a match. Sequences up to 2^53 - 1 store and read back; above that a JavaScript reader loses precision; above 2^63 the node drops the put | Local nodes of one implementation. Not the public DHT, not a relay |
| Sequence values that are not clock times | Nothing in the app's Pkarr code, the Desktop's Rust client or the `pkarr` 8.0.2 crate filters on freshness | From reading the code, not from a running relay |
| Turn record size as first specified (JSON, sealed, base64url) | 989 bytes for 4 named devices and a release, 11 under the limit, and over it with a name that JSON must escape. A binary body fits 7 devices | Measured with the app's own packet builder |
| A non-extractable Ed25519 WebCrypto key | Generates, refuses export and wrap, signs after a reload and a browser restart, works in a worker | Chromium 153 and WebKit 26.6 under Playwright. Tauri's WebViews (WKWebView, WebKitGTK, WebView2), Firefox and Safari as an installed app on iOS are unverified |
| `navigator.storage.persist()` | Returned false with no prompt in both headless browsers | Headless; a person cannot force it either way |
| Bark and Fedimint databases | Bark's two are plain IndexedDB; Fedimint's client file is a redb file whose format follows the pinned wasm build, not the browser | From reading code and SDK sources. Nothing was moved with funds |

To be measured before or during phase 1, each with its experiment. A row that fails changes the section it names.

| Unknown | Experiment | Section it decides |
|---|---|---|
| A relay's answer to a different packet at an equal sequence, to `If-Match`, and to a sequence that is not a timestamp | PUT a lower, an equal-but-different and a conditional packet to a local `pkarr-relay` and to both public relays; record the status codes | [Publishing and reading](#publishing-and-reading) |
| Public Mainline nodes at an equal sequence, and whether they honour `cas` | Put two values from two clients, read from several nodes | The same |
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
- **Device key**: an Ed25519 key made on the device, in no backup and in no handoff. It is described as what it is: where the WebView offers Ed25519 in WebCrypto, the key is generated non-extractable, so **the app cannot export it**; it is still bytes in the browser's storage on disk, and copied storage copies it. Where WebCrypto lacks Ed25519 (Safari before 17, and any WebView not yet verified), the key is a stored seed like every other key in the profile. No OS keychain is used. The device key does three things: it signs the turn record, it authenticates the device's links, and it signs a release.
- **Device set**: the devices enrolled in one profile, at most 4. It has one secret, the **device-set secret** `D` (32 bytes), held by every enrolled device.
- **`D` is the authority.** Whoever holds `D` can write the turn record and can enroll a key. Device signatures say which device wrote and let the others show it; they do not limit a holder of `D`. A backup of an enrolled profile contains `D`, so **a backup holder is a `D` holder**.
- **The first `D`** is derived from the profile's DID key, which every backup already carries: `D0 = HKDF-SHA256(ikm = DID seed, salt = "ghostly-devices/1", info = "device-set", 32)`. So a bundle made before the profile had a second device still leads a 1.1 app to the turn record. After a device is removed, `D` is random (see [Removing a device](#removing-a-device)).
- **Turn**: a counter. The device that holds the highest turn is the active one.
- **Device link**: an authenticated channel between two of the person's devices. It is an ordinary paired chat session ([401](401-paired-chat.md)) whose keys are **derived from `D` and the two device keys**, so any two enrolled devices have one without ever having met, and a removed device has none once `D` changes:
  - `linkSecret = HKDF-SHA256(ikm = D, salt = "ghostly-devices/1", info = "link" || lowerKey || higherKey, 32)`;
  - each side's rendezvous seed is `HKDF(linkSecret, info = "rv" || ownDeviceKey)`, the link's sealing key `HKDF(linkSecret, info = "enc")`;
  - each side's participation key **is its device key**, pinned from the turn record. Trust on first use is off for a device link (`trustOnFirstUse: false`; chats default to on, `packages/core/src/ghostlink.ts`).
  A holder of `D` can compute both rendezvous seeds, so it can disturb a link's rendezvous; it cannot pass the session's authentication without a device key. The link reuses the transports ([100](100-transports.md)) and the file transfer ([501](501-paired-files.md)) and is never listed among chats.

Choice recorded: the reviews offered "derive the links" or "two devices only in phase 1". Links are derived. Two devices would have been simpler to test, but removal and a third device both need a link between devices that never enrolled each other, and deriving the link also retires the bearer secret that a first design showed in the QR code for the life of the link.

### States of a device

| State | Meaning | What it does on the network for this profile |
|---|---|---|
| `single` | The profile has no device set (today's behaviour, and every CLI profile) | Everything, as today |
| `active` | Holds the turn | Everything, plus the turn record |
| `standby` | Enrolled, not active. Holds its device key, `D`, the device set and either nothing else (**no copy here**) or a **frozen copy** of the state as it was when it last released | **Device-link-only mode**: reads the turn record, publishes and reads the rendezvous records of its device links while the app is open, answers those links. Nothing else |
| `releasing` | Was active, has frozen its database for a handoff, has not signed the release yet | Device-link-only mode. Goes back to `active` on cancel |
| `taking` | Holds a release and a verified staged state, has not yet seen its own turn accepted | Device-link-only mode |
| `superseded` | Found a higher turn that it did not release | Device-link-only mode |
| `removed` | Taken out of the device set | Nothing |

### The gate

Device-link-only mode is a different start, not a flag checked here and there.

- The device state is read **before** `GhostlyNode.start()` runs anything, on every client: the web app's first `engine.connect()`, the extension's `onStartup` and `onInstalled`, the Desktop's webview. Today `start()` starts identities and the DID first, then every wallet, then chats (`packages/browser/src/engine/node.ts`); none of that may run.
- In any state but `single` and `active` the client **does not open the peer database at all**. It starts a small engine that knows only the device state, the turn record and the device links. So no wallet SDK starts (they start eagerly today), no DID or proof record is put, no chat or group link starts, no hold poll runs, and an app update never migrates a frozen copy.
- **Profile peek** ("Check other profiles", [04](04-profiles.md#checking-other-profiles)) skips a profile that is not `single` or `active`: it reads mailboxes with the profile's own keys, which a standby must not do, and a standby would show unread counts.
- The notice of [the newer-version check](#versions) is never raised by a frozen copy: nothing opens it.
- Stopping is done by **writing the state and reloading into the gate**, never by trusting each SDK to close. Bark runs a background daemon and Fedimint holds an exclusive file handle; a reload ends both.

### Durable device state

The device state decides safety, so it is stored apart and strictly:

- a small database of its own, `ghostly-devices`, one record per profile: state, turn, `rev`, the stored signed turn packet, the device set, `D`, the lineage and takeover count, the handoff in progress (role, step, staging namespace, the release);
- every write uses `durability: "strict"` and waits for the transaction to complete. The Desktop also writes the same record to a file through a Rust command that calls `fsync`, and at start takes the stricter of the two (a state other than `active` wins);
- the profile's own storage is found through the registry ([04](04-profiles.md#local-model)); a handoff installs a new storage namespace by changing one pointer (see [Installing](#installing-the-staged-state)).

"Durably" in this document means exactly this. The guarantee assumes a strict write survives a crash and a power loss; whether each engine honours that is on the measurement list.

### Adding a device

Today's path is a backup restored on the second device. It copies every secret through a passphrase file, leaves the first copy running, and nothing tells either copy about the other. Enrollment replaces it.

**Conditions.** The profile has a lock password of at least 8 characters (the lock screen allows 4 today; a device set needs 8), typed again on the active device to open **Add a device**. On iPhone and iPad the new device is the app on the Home Screen: a Safari tab has other storage, so **Add this device to my profile** is offered only in the installed app, and a tab says "Add Ghostly to your Home Screen first." Elsewhere the client calls `navigator.storage.persist()` and, when it is not granted, warns and goes on: "This browser may clear Ghostly's data. Keep a copy on <device>."

**The invite.** A new invite version (the bech32m code of [800](800-invite-join.md), version symbol 2), since today's has four fields and no flag, expiry or use count (`packages/core/src/invite.ts`):

| Field | Size |
|---|---|
| One-time rendezvous seed for the joiner | 32 bytes |
| One-time link key | 32 bytes |
| The inviter's one-time rendezvous key | 32 bytes |
| The inviter's device key | 32 bytes |
| Flags (bit 0: own device) | 1 byte |
| Expires, UNIX seconds | 4 bytes |

It is shown as a QR code and as a code to copy, through the existing `JoinDialog` (scan, paste, open an image). The code may travel by any channel the person likes: the digits below protect it. The inviter enforces the 10 minutes and the single use; an app from before this WISP does not know version 2 and must refuse the code.

**The session** is a paired session on that one-time link, with capability `enroll/1` and these frames:

1. `B → A` `{"t":"enroll-hello","k":"<B's device key>","name":"Phone","kind":"web","app":"1.1.0","s":"<signature>"}`, signed with B's device key over `["ghostly-enroll", transcriptHash, A's key, B's key]`. The transcript hash is the session's ([401](401-paired-chat.md)); device keys are not in it, which is why both are signed in here.
2. `A → B` `{"t":"enroll-proof","s":"<signature>"}`, the same tuple signed with A's device key. B checks it against the key in the invite.
3. Both compute six digits: the first 20 bits of `SHA-256("ghostly-enroll-digits" || transcriptHash || A's key || B's key)`, as a decimal number modulo 1,000,000.
4. The person confirms on A that both screens show the same digits.
5. `A → B` `{"t":"enroll-grant","d":"<D>","set":[[key, name], ...],"turn":N,"rev":R}`. B stores it durably as `standby` and answers `{"t":"enroll-done"}`.
6. A publishes the turn record with B listed. Only then is B a device.

Two rules make the digits enough, without a commitment round:

- **One session per invite.** A admits the first joiner that authenticates and voids the invite. A second joiner gets nothing, and A says so.
- **B shows digits only after it verified A's proof** against the invite's key.

So an attacker who photographed the code and joined first holds A's only session; the person's own device shows an error and no digits, and nothing is confirmed. An attacker cannot sit between the two either: B knows A's key from the code. If step 5 or 6 does not finish, B holds nothing usable (it is not in the record) and shows "Not finished" with **Remove**; A adds no device.

Enrollment transfers `D` and the device set, **nothing else**: no chat key, no wallet, no storage credential. The new device ends on the standby screen, which offers the first handoff at once: "Bring my profile here now · 480 MB".

### A backup restored where a device set exists

A backup of an enrolled profile carries `D`, the device set and the turn it was made at, never a device key (stripped like the push subscription and the storage credentials are today). A bundle made before enrollment carries the DID key, from which a 1.1 app derives `D0`. Either way the client, before it registers the restored profile:

1. derives the turn address and reads the record ([Publishing and reading](#publishing-and-reading));
2. finds **no record** and no device set in the bundle: restores as today (a profile that was never enrolled). A record that expired because every device was off for hours is missed here, which is a limit until every profile keeps a record ([open question 3](#decisions-and-open-questions));
3. finds **a record with a device active**: does not start the copy. It says "This profile is active on <device>" and offers **Add this device instead** (enrollment, then a handoff: the safe path), **Take over** (a [forced takeover](#forced-takeover), for when the other devices are gone) or **Cancel**;
4. finds **a tombstone** (the device set moved to a new `D` after a removal): says "This backup is from before a device was removed. Starting it makes a second copy of your profile." It cannot take over (it has no current `D`). It may start only as a profile of its own, after the person types the profile's name, and that copy is the "two live copies" case of [05](05-backups.md#security-and-operation), which nothing here can stop;
5. **cannot read** the record: does not start the copy, and says so.

A start from a bundle is a forced takeover in every case: the bundle is older state. An app from before this WISP cannot be stopped from restoring a bundle that it can read; see [Compatibility](#compatibility-and-rollout).

### Removing a device

Phase 1 includes removal: the phone is the device most likely to be lost, and the superseded screen offers it. On the active device: Profile, Devices, Remove. The client:

1. makes a new random device-set secret `D'` and so a new turn address and new device links;
2. sends `D'` to each remaining device over its old link (authenticated by device keys, so the removed device cannot join that session). A device that is off gets it at its next link, and shows "Open Ghostly on <active device> to finish" until then; the active device keeps the old link to that device alone until it has;
3. publishes the turn record at the new address, without the removed device;
4. publishes a **tombstone** at the old address and puts it again every hour while the profile exists.

The tombstone is the turn record with turn 2^32 - 1, the highest `rev` and no active device (`active` is 255). It keeps the old device set in its slots (the record is sealed, so nothing new shows) and is signed by the removing device from its own slot, so it verifies by the reader's ordinary rule. It tells an **honest** device that was removed or left behind, whenever it comes back, to stop. It is not a lock: a DHT node accepts another packet at an equal sequence, so a holder of the old `D` can replace it, and the active device's hourly put restores it.

What removal can and cannot do depends on what the removed device held:

| The removed device was | Someone holding it unlocked can | Cannot | What the person should do |
|---|---|---|---|
| A standby with no copy | Read the old turn record (device names, the turn). Ask for a handoff until removed, which needs the lock password, with limited attempts ([Authorizing a handoff](#authorizing-a-handoff)) | Read a message, reach a contact, touch money | Remove the device. Nothing else |
| A standby with a frozen copy | Read all history up to its last release: **a frozen copy is not encrypted**, and the lock password is a screen gate only. Act as the person to every contact, read new DHT texts and held items (they are sealed to the chats' static keys), and spend from every wallet whose seed or credential is in the copy | Take the turn under `D'` | Remove the device, then the money steps and the chats below |
| The active device | The same, with current state | The same | Force a takeover from another device, then the same |

**Removal protects the turn, not the keys.** Chats have no key rotation ([02](02-peer-keys.md) leaves it open), so a copied chat key stays valid until the chat is paired again. So the forced-takeover and the remove screens ask **Lost or stolen?** and, on yes, lead to the money step first:

- **Phase 1: a written checklist**, one line per wallet the lost device could spend from, each with its button where one exists: Cashu, "Swap all ecash now" (every proof is swapped at its mint, so the copies are spent); wallets with a phrase, "Make a new wallet and send the funds to it"; remote Lightning, "Revoke the connection at your node". The guided flow that does these in one pass is phase 2.
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
| 1 | 4 | `turn`, unsigned, big-endian, at most 2^32 - 1 |
| 5 | 3 | `rev`, unsigned, under 2^18 |
| 8 | 1 | `author`: index (0 to 3) of the device that signed this record |
| 9 | 1 | `active`: index of the active device, or 255 for none (a tombstone; in phase 2, a prepared handoff) |
| 10 | 1 | Number of devices, 0 to 4 |
| 11 | 192 | Four slots of `deviceKey(32) || name(16, UTF-8, zero-padded)`; unused slots are zero |
| 203 | 8 | `instance`: random, made by the active device each time its engine starts |
| 211 | 1 | Release present, 0 or 1 |
| 212 | 1 | Release: `from`, the index of the device that gave the turn up |
| 213 | 1 | Release: `to`, the index of the device it was given to |
| 214 | 32 | Release: `H`, the digest of the state handed over |
| 246 | 64 | Release: `from`'s signature over `"ghostly-turn-release" || turnAddress(32) || turn(4) || toKey(32) || H(32)` |
| 310 | 64 | The author's signature over `"ghostly-turn" || turnAddress(32) || body[0..310]` |

374 bytes of body, 414 sealed, 552 characters of base64url: a packet of about 640 bytes by estimate (the review measured a binary body with 7 devices at 938). The exact packet and test vectors are a blocker before Proposed. A device keeps its slot for life; a name longer than 16 bytes is cut at a character boundary.

**The BEP44 sequence number is `turn * 2^20 + rev * 4 + author`**, not the clock. The first turn is random under 2^29, so the sequence stays under today's microsecond clock and the absolute count says nothing; the highest value, the tombstone's, is under 2^52, exact in JavaScript and far from the dates a relay cannot format. Folding the author's slot into the low bits means **two devices never sign an equal sequence**, whatever they race on. A lower sequence is refused by a DHT node (measured) and, by its source, by a relay (409); a stale device that tries to put its old record back learns from the refusal that it was replaced.

A reader accepts a record that: verifies as a BEP44 packet under the turn key; opens under the seal key; has version 1 and a consistent layout; is signed by the key in its own slot `author`; has a sequence not lower than the highest it holds; and, when a release is present, whose release verifies under the key in slot `from`, names the record's turn and the key in slot `to`, with `to` equal to `active`. A reader that knew the previous record also checks that `from` was the active device there, and shows a mismatch as a takeover without a release.

**An unknown signer is accepted.** A record with no release whose author is a key the reader never saw is a forced takeover by a holder of `D` (for example a restored backup with a new device key). It is valid, it supersedes, and every device shows it as such. This follows from "`D` is the authority"; a rule that refused it would leave two devices active for ever.

If two valid records at one sequence ever meet (they cannot be signed by two devices; a clone can do it), a reader compares the opened bodies and keeps the one with the lower `instance`; the copy whose `instance` lost stops. It never uses a library's own rule for equal sequences: the `pkarr` crate prefers the larger encoded bytes, which for a sealed record is random.

### Publishing and reading

The turn has its own publish and read path. The chat path (`packages/core/src/relay.ts`, the Desktop's `relay_put` and `Dht::publish`) is wrong for it in four ways: it reads until the first relay answers, it calls a put done when one relay took it, it sends a refused conditional put again without the condition ("one writer per key, so insist"), and the Desktop passes no compare-and-swap value.

**Put.**

- A device signs and seals a record once and **stores the packet's bytes**. Every later put of that record sends the same bytes: a fresh nonce at the same sequence would be a different packet, which a node may take as a conflict.
- A put that raises the turn or the `rev` is conditional on the sequence it replaces: `cas` on the DHT (measured to work), `If-Match` on relays (to be measured; if a relay ignores it, the race stays open there and is in the "detected" list).
- **A refusal is an answer, never retried without the condition.** Error 301 or 302 from a node, 409 or 412 from a relay, mean someone else wrote: read.
- The put reports each source's answer; "one relay took it" is not success by itself.
- The active device puts its stored bytes at start and every hour. An identical packet refreshes the item without an update ([3xx did:dht](3xx-did-dht.md#publishing) measured 204).

**Read.**

1. Ask **every** configured relay, and on Desktop the DHT itself, in parallel, 8 seconds each.
2. Verify and open each answer; drop what fails.
3. Take the highest sequence among them and the record stored locally.
4. The result is one of:

| Result | Meaning |
|---|---|
| `mine` | The highest record names this device as active, with this engine's `instance` |
| `other` | A higher turn, or another device active at this turn |
| `clone` | This device's key is active at this turn with another `instance`: another copy of this device's storage is running |
| `tombstone` | The address is closed |
| `none` | At least one source answered, and none has a record |
| `unreachable` | No source answered |

A read is **good** when at least one source answered. Both default relays are run by one operator (`packages/core/src/relay.ts`), so in the web app and the extension "several relays" gives no independence: one operator can hide a newer record. Desktop also asks the DHT.

### Who may raise the turn

- The device that takes a normal handoff, with the release of the device that was active.
- A device that forces a takeover, with no release. The record says so, and every other device shows it.

Each needs the person to press a button. Nothing raises the turn by itself.

### When a device checks

A relay read is not free: the web app and the extension share 30 requests a minute per relay with every chat ([04](04-profiles.md#checking-other-profiles)). The turn is not read before every send. An active device reads it:

- **at start, as a condition of starting.** With a good read that says `mine` or `none` it puts its record and starts. With `unreachable` it shows "Can't check which device is active" with **Try again** and **Start anyway**; started that way it runs in **limited mode** until a good read: no single-writer wallet is opened, no real money is spent, no admin work is done;
- when the app comes back to the front, the network changes or the machine wakes;
- every 10 minutes (with jitter) while it runs;
- when its last good read is older than 60 seconds, **before** each of: a Mainnet spend; opening a single-writer wallet SDK on any network (Fedimint, Spark, Ark, Bark); a group commit; taking door duty in a community. If the read is not good, the action does not happen;
- at once on a hint: a device link that says "I took the turn"; a refused put of its own record; one of its own chat records (its capability record or mailbox) carrying an inner counter higher than its own; a contact's session replaced by another dial-in where the transport reports it.

A hint is never authority. A contact or a relay cannot make a device give the turn up; it can only make it read the record.

A standby reads the record when its screen is opened and every 10 minutes while it shows.

### When a device finds itself superseded

On `other`, `clone` or `tombstone`, at once: it writes `superseded` (or `removed`) durably and **reloads into the gate**. Nothing is said to contacts and nothing more is published. The reload ends every session, timer and wallet SDK. Its state stays as it is; what only it holds is the subject of [After a forced takeover](#after-a-forced-takeover).

On `clone`, the copy that reads a foreign `instance` in a record with a higher sequence stops: the copy that started last wrote that record (each start raises `rev`) and goes on. At an equal sequence the lower `instance` goes on. This detects a cloned storage at the clone's next read, which the first design could not.

### Failure cases

| Case | What happens |
|---|---|
| Normal handoff, the old device then goes offline for a month | Nothing to do: it wrote `standby` durably before it signed the release, so it never acts again without a handoff back |
| Forced takeover while the old device is off; it comes back | It reads the higher turn at start, before the engine starts, and becomes `superseded` without publishing |
| The same, and it comes back where no relay answers | It does not start by itself. If the person chooses **Start anyway**, it runs in limited mode: chats over live transports work, admin work and money do not. That is the double-active window, and its cost is in the next section |
| The record expired (a DHT node keeps an item about two hours) while every device was off | The first device to start reads `none`. An active one puts its stored record and goes on. A standby stays a standby. If a stale active device returns first, the newer one, at its own start, reads the lower record and puts its higher one, and the stale device stops at its next read or refused put |
| Clocks wrong by days | No effect on the turn. A clock far ahead still makes that device's chat packets win during a double-active window, as today |
| A relay operator hides the new record | A web or extension device that reads only that operator is not told it was replaced. Desktop also reads the DHT. Hints remain |
| A buggy standby that publishes chat records | The active device notices its own records carrying counters it did not write, reads the turn, finds itself still active, and reports "Another copy of this profile is acting" with the device list. It cannot stop the other copy |
| A hostile holder of `D` raises the turn | The real device becomes `superseded`. Its screen offers **It wasn't me**: take the turn back and remove that device, which moves the set to a new `D` |
| A device's storage was copied (a disk image, a phone restored to a new phone, a browser profile folder) | Two installs share one device key. The `instance` in the record exposes it at the next read of whichever started first; that copy stops |

### What is and is not guaranteed

**Guaranteed, for a normal handoff only:** at most one device is active at any moment, with no dependence on relays, clocks or timing. Assumptions: both apps are unmodified; neither device's storage is copied or rolled back from outside; a strict durable write survives a crash and a power loss. The reason: the old device makes itself `standby` durably before it signs the release; the release names its taker; the taker starts only once it holds that release, has verified the whole state, and has seen its own turn accepted and read back. Between the two there may be a moment with no active device, never two.

**Detected, not prevented** (bounded by the next good read of the turn record, at most about 10 minutes while a source answers):

- a forced takeover while the old device is alive;
- a start from a restored backup, when the person chooses Take over;
- cloned storage.

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
5. **Pass 2, the rest.** `A` sends the manifest of everything else (the peer database, the profile's local keys, wallet databases that move, files that arrived during pass 1) and then the parts. This is small next to the files: the offline gap is seconds to a minute, not the length of the copy.
6. **Verify.** `B` checks every part against the manifests, computes `H`, checks room and versions, and answers `handoff-verified`.
7. **Release.** `A` writes `standby` durably (released turn `N + 1` to `B`, digest `H`), **then** sends `handoff-release`. From the durable write on, `A` is on standby even if the frame never arrives.
8. **Take.** `B` stores the release durably as `taking`, installs the staged state, puts the turn record `N + 1` conditionally on `N`, **reads it back**, and only on `mine` writes `active` and starts the engine. It tells `A` (`handoff-done`). If the put is refused, someone else wrote: `B` reads, and stays `taking` or becomes `standby` as the record says.

**Cancel is safe until step 7.** A drop between 7 and 8 leaves nobody active, never two. `B` needs nothing more from `A`: it holds the release and the verified state, and finishes alone when it has a network. `A`, meanwhile, shows "Moving to <B>. Waiting for it to finish." and **Use here**; that button reads the turn first: if `N + 1` exists it answers "<B> finished the move. This device is on standby."; if the turn is still `N`, it is a forced takeover and says so. `B`'s conditional put then fails, and `B` drops its staged state.

A contact's dial-in during the gap finds nobody, as when the app is closed. Contacts cannot call or pay meanwhile; their apps say so with today's words ("Calls need a live connection", "Payments need a live connection"), and texts wait in the DHT mailbox or a hold.

### Frames

All frames travel on a device link only, under a capability `handoff/1` that only device links offer. They carry no message id, as other session frames that older apps drop.

| Frame | From | Body |
|---|---|---|
| `handoff-hello` | both | `{"v":1,"app":"1.1.0","db":12,"pins":{"ark":"0.4.74","bark":"0.25.0","fedimint":"<build>","breez":"<version>"},"kind":"web","room":<bytes free>,"metered":<bool>}` |
| `handoff-request` | B | `{"turn":N}` |
| `handoff-offer` | A | `{"turn":N}`; B answers with `handoff-request` once the person agrees |
| `handoff-busy` | A | `{"why":"handoff" or "payment" or "call" or "locked-out","retry":<seconds>}` |
| `handoff-pake` | both | `{"n":1 to 3,"m":"<base64url>"}`, the three messages of the password proof |
| `handoff-have` | B | `{"part":"<name>"}`: a file part, sent first, holding the 32-byte digests of the files B holds, sorted |
| `handoff-manifest` | A | `{"pass":1 or 2,"parts":[[name, size, sha256], ...]}` |
| `handoff-verified` | B | `{"h":"<H>","s":"<B's signature over [\"ghostly-handoff-verified\", turnAddress, N + 1, H]>"}` |
| `handoff-release` | A | `{"turn":N + 1,"to":"<B's key>","h":"<H>","s":"<the release signature of the turn record>"}` |
| `handoff-done` | B | `{"seq":<the sequence it read back>}` |
| `handoff-cancel` | either | `{"why":"..."}`; valid from A only before `handoff-release` |

Parts travel as files of [501](501-paired-files.md) (resumed from confirmed bytes after a drop), each sealed with the stream key of the password proof or, on a push, of the session. A part's `name` is one of `db/<store>`, `local`, `file/<sha256>`, `wallet/<type>/<name>`.

**`H`** is `SHA-256` of the UTF-8 bytes of `JSON.stringify(["ghostly-handoff/1", N + 1, fromKey, toKey, parts])`, where `parts` is every part of both passes and every part `B` already held and keeps, as `[name, size, sha256]` with `sha256` in base64url, sorted by `name` as byte strings. Only arrays, strings and integers appear, so the form is canonical.

### States and events

One handoff at a time per profile: a second request gets `handoff-busy`.

| A is | Event | A does | Next |
|---|---|---|---|
| `active` | `handoff-request`, or the person presses Move to | Checks versions; starts the password proof (pull) | authorizing |
| `active` | A request while a call is on, or from a locked-out device | `handoff-busy` | `active` |
| authorizing | Proof fails | Counts the attempt, notice on screen, `handoff-busy` when the limit is reached | `active` |
| authorizing | Proof holds; no frame for 60 s | Cancels | `active` |
| pass 1 | `handoff-have` | Sends manifest 1 and the files | pass 1 |
| pass 1 | No confirmed bytes for 2 minutes, or the link drops | Pauses; resumes when the link is back; gives up after 24 hours | pass 1 or `active` |
| pass 1 | All files confirmed | Tries to quiesce; if a payment runs, waits up to 30 s, then `handoff-busy` `payment` | quiescing or pass 1 |
| quiescing | Database frozen | Writes `releasing`, reloads into the gate, sends manifest 2 and the parts | pass 2 |
| pass 2 | The link drops, or no `handoff-verified` within 10 minutes of the last part | Writes `active`, reloads, starts | `active` |
| pass 2 | `handoff-verified` with a valid signature and the same `H` | Writes `standby` durably, sends `handoff-release` | `standby` |
| `standby` (just released) | `handoff-request` again from B with the same turn | Sends the same release again | `standby` |
| `standby` | `handoff-done` | Applies the [on standby](#what-moves) column | `standby` |

| B is | Event | B does | Next |
|---|---|---|---|
| `standby` | The person presses Use here, or accepts an offer | Dials A, hello, request | requesting |
| requesting | No session within 30 s | "Can't reach <device>. It must be on, with Ghostly open." Sends a wake push to A when A shared a target | `standby` |
| requesting | `handoff-busy` | Shows why | `standby` |
| receiving | Parts | Writes to staging, checks each digest; a bad part is asked again once, then the handoff fails | receiving |
| receiving | All parts of pass 2 | Verifies, sends `handoff-verified` | verified |
| verified | No release within 60 s | Asks again each time the link is back; never starts without it | verified |
| verified | `handoff-release` that verifies | Writes `taking` durably, installs | `taking` |
| `taking` | Install done | Conditional put of `N + 1`, read back | `taking` |
| `taking` | Read says `mine` | Writes `active`, starts, sends `handoff-done` | `active` |
| `taking` | Read says `other` | Drops the staged state | `standby` |
| `taking` | Read is `unreachable` | Waits and tries again; shows "Finishing: waiting for the network" | `taking` |

### Authorizing a handoff

The active device is often unattended (the desktop at home while the person is out), so it cannot be asked to confirm. A pull is authorized by the device link (the device keys of the turn record) **and** by the profile's lock password, typed on the taking device and proven to the active one without sending it:

- **Protocol:** SPAKE2+ ([RFC 9383](https://www.rfc-editor.org/rfc/rfc9383)), suite P256-SHA256-HKDF-SHA256-HMAC-SHA256, an augmented exchange: the active device stores a verifier, not the password. The verifier is made when the lock password is set or changed, from the password with PBKDF2-SHA256, 600,000 rounds and its own salt, and it moves with the profile. The taker gets the salt in the first message.
- **Binding:** the exchange's context is `"ghostly-handoff/1" || turnAddress || A's key || B's key || the session's transcript hash`. Its shared key derives the stream key that seals every part, so the state is unreadable without the password even to someone who broke the link.
- **Attempts:** the active device counts failures per taking device. After 5 in an hour it answers `handoff-busy` `locked-out` for an hour; after 15 with no success between them it refuses that device until the person, on the active device, chooses "Let <device> try again". Every failure raises a notice on the active device: "<device> tried to move this profile with a wrong password."
- **What it protects:** a stolen standby with no copy cannot pull the profile, and gets a handful of guesses. It does not protect a frozen copy: that data is already on the stolen device, unencrypted.

The protocol choice is a candidate; a reviewer of the implementation may prefer another augmented exchange, with the same binding and limits.

### Versions

The first frame carries the app version, the database version (`DB_VERSION`) and the pinned version of each wallet SDK, so a handoff that cannot work fails before the copy:

- A device takes only what its app can read. `B` with an older database version than `A` is refused: "Update Ghostly on this device first."
- A newer `B` migrates the state on arrival, as an app update does. `A` is then the older one, and must update before it can take the profile back; its standby screen says, in the words the app already uses for this, "This profile was last used by a newer version of Ghostly." and "Update the app to open it." On the installed web app, updating is Settings, Updates, Check now.
- A wallet whose SDK pin differs between the two devices does not move in that handoff; it stays home ([Wallets that stay home](#wallets-that-stay-home)).
- A frozen copy is never opened and never migrated by an app update.

### Installing the staged state

`B` never writes into a live profile. Incoming parts go to a **staging namespace**: a new storage namespace as a restore makes one ([05](05-backups.md#restore) already writes "every store and key before the profile is registered"), with its own peer database, local keys and file area. Files `B` already held are linked into it, not copied.

- **Install** is one durable write: the profile's registry entry points at the staged namespace. Before it, `B`'s old frozen copy is the profile's storage; after it, the new state is. The old namespace is kept until `active` is written: if the put of step 8 is refused, the pointer moves back to it and the staged one is deleted. Only then is the old one deleted.
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
| `standby` (released) | `taking`, not installed | B installs, puts, reads back, starts |
| `standby` (released) | `taking`, installed, turn not seen | B puts again (the same stored bytes), reads back, starts |
| `standby` (released) | `active` | Done. B sends `handoff-done` again when they next meet |
| `standby` (released) | Gone for good, or its storage lost | Nobody is active. A's **Use here** reads the turn: still `N`, so it offers a forced takeover from its own frozen copy, which is the state B was given |

### What moves

Columns: whether it moves; whether it must arrive exactly once and in full; whether it could be rebuilt without the other device; what the device that goes to standby does with its copy.

In phase 1 **a device that goes to standby keeps its frozen copy**. It makes coming home cheap (only new files move), it is the only recovery if the phone's browser clears its storage, and it means there is never a moment with one copy of the profile in the world. "Keep no copy here" is a phase 2 option, allowed only while another device holds a copy.

| State | Moves | Exactly once | Can be rebuilt | On the device that goes to standby |
|---|---|---|---|---|
| Device key | Never | n/a | n/a | Kept |
| `D`, device set | Not in the stream (enrollment gave them) | n/a | By enrolling again | Kept |
| Chats: rendezvous seed, invite secret, participation seed, pinned contact key, trust | Yes | Secrets | No: lost keys end the chat | Frozen |
| Per-chat counters: mailbox `sequence` and `peerSequence`, capability `rev`, hold `pointerRev`, `outSeq`, `inSeq`, `peerAck`, hold mailbox name | Yes | **Yes** | No. Lower values are dropped silently by the contact | Frozen; never used again without a handoff back |
| Native transport seeds per chat | Yes | No | Yes: a new seed is a new endpoint, which the capability record then describes | Frozen |
| Sessions, dial timers, attempt counts, quotes shown but not approved, a community door's pending admissions | No (in memory) | n/a | Made again; a joiner at the door tries another hub after 30 seconds | Gone |
| Outbox: message rows in `sending`, `queued`, `waiting`, `held`, with wire ids and resend window; pending edits, reactions, pins | Yes | Ids make a resend harmless | No | Frozen |
| Message history | Yes | No | No | Frozen, not shown in phase 1 |
| Items held for contacts in the hold storage | Stay in the storage; their records move | Sequence numbers, yes | No | n/a |
| Files (OPFS, Desktop files, database pieces) | Yes, whatever the size, in pass 1, skipped when the taker holds the digest. Files left for later show as "On <device>" and are fetched over the device link when both are on | No | No | Frozen. A standby serves a file over a device link; that is all it serves |
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

1. reads the turn (a good read is required: it must know the turn it replaces);
2. puts turn `N + 1` with no release, conditionally on `N`, itself in its slot (a restored copy takes a free slot with its new device key, or the lost device's slot when all four are used), and reads it back;
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

**Not raised:** edit numbers (capped at 100 per message, `packages/core/src/pairedEdits.ts`), pin numbers (clock-bound: refused more than 5 minutes ahead, `packages/core/src/pins.ts`), message ids (random), incoming high-water marks (something taken twice is removed by its id). So after a forced takeover an edit of a message that the lost device edited later can be ignored by the contact as older; the person edits again.

What contacts on any version see once, after a forced takeover: in a chat with holding on, the line "The contact holds items for you, but their address expired" and a faster poll until the first real held item; in a group, up to 255 frames counted as missing from that member. Neither loses a message. To be tested: the groups' seen windows and the hold manifest's "strictly increasing" rule with a floor and a stride.

### After a forced takeover

If the old device comes back it is `superseded`, and its state has forked from the active one. Phase 1 keeps that state untouched and says what is there ("3 messages and 1 payment are only on this device"); it deletes nothing. Phase 2 adds **Send what is only here** over the device link: messages and their files by id, and unspent Cashu proofs as tokens that the active device redeems at the mint (what was already spent fails harmlessly). Nothing else is ever merged: not counters, not group state, not settings.

### Later phases, in short

- **Prepared handoff (phase 2).** For "the desktop is off and I am out". The active device saves a sealed snapshot to the person's S3-compatible storage and stops. Changes the reviews require, to be specified with that phase: the handoff **names its taker** ("Save for pickup by Phone"), so its release is an ordinary release and it stays inside the guarantee; no storage credential is given at enrollment (the record's pair is a second sealed record with a presigned address valid at most seven days, and the release is also in the object's header); any enrolled device may put the stored turn packet again so the record outlives two hours with every device off; the snapshot is a multipart stream, since [1002](1002-s3-storage.md) bounds an object and allows only `backups/` and `hold/` names today; a local file can be the carrier.
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
| **Cashu** | Moves | Proofs, pending melts (with reserved proofs and blank outputs), mint quotes and history move exactly once. Quiesce drains the per-mint lock first: `createToken`, the split before a melt and `receiveToken` swap at the mint before any local write and save no outputs, so they must end, not be cut (`packages/browser/src/engine/wallet.ts`). The standby's frozen proofs are marked `moved` (new work) | Both spend the same proofs: the second spend fails at the mint, which can break a payment a contact was promised. Change or received ecash that exists only on a device that is later wiped is lost | Every frozen proof is checked at the mint before it counts (new work); spent ones are dropped. Ecash the lost device received after its last release is gone unless that device comes back |
| **Ark via Arkade** | Moves, once the move test passes; until then stays home | The phrase and the database (`ghostly-ark-<wallet id>`) move whole, under a new local name | Two copies sign from the same coins and disagree about renewals | The stale database is what a restored backup has today, with the same open risk ([202](202-arkade.md) lists stale copies as an open gate). Needs the provider's word; until then a forced takeover parks the wallet as "Needs your decision" |
| **Ark via Bark** | **Stays home** in phase 1 | When it moves (phase 2): both databases move by a database snapshot taken after the SDK has stopped, imported before the SDK first opens that name; refused on a pin mismatch and **while an exit or a round is pending** (the 30 seconds of quiesce are shorter than a round) | As Arkade. An exit in progress needs this device's database | The server's recovery scan runs when a wallet is opened on an empty database (the SDK's default, by the review's reading of its source; the SDK is not in this tree to confirm). The on-chain scan runs only for a typed phrase (`packages/browser/src/engine/paymentAdapters/bark.ts`) and would have to run here too. A send's outcome is found by a movement id that exists only in the old database, so an `unknown` attempt never resolves on a fresh one: it is parked for the person |
| **Fedimint** | **Stays home** in phase 1 | When it moves: the client file is copied byte for byte at the same client build, after the worker releases its handle; otherwise recovery from the guardians | Two clients on one phrase collide on keys ("never joined fresh twice with one mnemonic", [2xx Fedimint](2xx-fedimint.md)) | Never open the old file: join with recovery. Whether the SDK backs up to the guardians by itself is unconfirmed, and recovery of a real profile is not yet exercised. A **Take over** from a restore while another device is alive would be a second join by one button: the SDK stays closed until a good turn read says this device is active |
| **Spark and the Breez Lightning source** | Moves (phrase and API key; the database is rebuilt from the operators) | The releasing device **deletes its Breez database** once the handoff is done: the database is named from the phrase and shared by the whole origin (`breezSdk.ts`), so a device that became active again would reopen a stale one | "Two SDK instances over one seed disagree about the leaves" ([2xx Spark](2xx-spark.md)) | Opens from the phrase and syncs. An unfinished send is looked up by its idempotency key, which is in the journal; an attempt the journal does not have cannot be found and is parked |
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
| Ecash a contact sends during the gap | Ecash is never held ([4xx](4xx-store-and-forward.md)); it needs a live session, so the contact's app waits |
| A file transfer with a contact | Stops at its last checkpoint and resumes from the new device |

**A forced takeover or a restore** (the old device cannot be asked): `pending` becomes `unknown`, as a restore does today; nothing is cancelled, because nothing can be known; saved signed bytes are parked. See [Forced takeover](#forced-takeover).

## User experience

Copy follows the app's rules: short labels, one-line hints, details behind ⓘ. `<device>` is a device's name. Devices live on the **Profile page, beside Backups** (`apps/ui/src/pages/Profile.tsx`). The app has no first-run screen today, so "I already use Ghostly" is new UI and part of the phase.

**Profile, Devices**

- Title: "Devices". Hint: "Use this profile on another device. One device is active at a time." ⓘ: "Only the active device sends, receives and pays, so your messages and money are never in two places. Move the profile whenever you like."
- Rows: name, kind icon, and one of "This device · Active", "Standby", "Standby · no copy here", "Not finished". Row menu: "Move to <device>" (on the active device, for a device that is on), "Rename", "Remove".
- Buttons: "Add a device". On a Desktop with a standby device: a switch "Keep this computer awake", hint "So your phone can take over while you are out."

**Adding a device**

- Without a lock password of 8 characters: "Set a password first". Hint: "Without a password, anyone holding one of your devices can take this profile."
- Active device, after the password: "On the other device, open Ghostly and choose Add this device to my profile. Then scan this code." QR code, "Copy code", "Valid for 10 minutes".
- New device, first screen: "I already use Ghostly", then "Add this device to my profile" or "Restore a backup". On iPhone in a Safari tab: "Add Ghostly to your Home Screen first."
- Both: "Do both devices show 482 913?" On the active device: "They match" and "They don't match". On the new one: "Confirm on <device>."
- New device: "Name this device" (prefilled: "Phone", "MacBook", "Firefox"; 16 characters).
- Where the browser did not grant persistent storage: "This browser may clear Ghostly's data. Keep a copy on <device>."
- Done, active device: "<device> added. It is on standby." Done, new device: the standby screen with "Bring my profile here now · 480 MB".

**What a standby shows**, the whole profile area, behind the lock screen:

| Device state | Title | Hint | Buttons |
|---|---|---|---|
| `standby`, turn read `other` | "Active on <device>" | "Moves this profile from <device>." | "Use here"; link "My other device is lost or broken" |
| `standby`, read `unreachable` | "Can't check which device is active" | "Check your connection." | "Try again" |
| `standby`, with an offer from the active device | "Move this profile here from <device>?" | "About 480 MB." | "Use here", "Not now" |
| `standby`, the other app is newer | "This profile was last used by a newer version of Ghostly." | "Update the app to open it." | "Check for updates" |
| `releasing` | "Moving to <device>" | "Nothing changes until the last step." | "Cancel" |
| `standby`, just released, no `handoff-done` | "Moving to <device>. Waiting for it to finish." | "Open Ghostly on <device>." | "Use here" (reads the turn first) |
| `taking` | "Finishing" | "Waiting for the network." | none |
| `superseded` | "This device was replaced" | "<device> took over without this one. This device has stopped." | "It wasn't me"; a line "3 messages and 1 payment are only on this device" |
| `removed` | "This device was removed" | "Add it again from <device>." | "Remove this profile here" |
| Enrollment not finished | "Not finished" | "Start again on <device>." | "Remove" |

ⓘ on the standby screen: "Only one device sends, receives and pays at a time, so your messages and money are never in two places."

The account switcher ([04](04-profiles.md)) shows such a profile with the word "Standby" in place of its unread count.

**Handoff progress** (on both devices)

- Title: "Moving your profile". Steps: "Connecting to <device>", "Copying files · 120 of 480 MB · 4 min" (with, on the active device, "You can keep using Ghostly"), "Getting ready", "Copying the rest", "Checking", "Switching".
- "Cancel". Hint: "Nothing changes until the last step."
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
| A part failed its check | "The copy was damaged. Nothing changed." with "Try again" |
| No room | "Not enough space on this device: 1.2 GB needed." |
| Older app on the taking device | "Update Ghostly on this device first." |
| A payment is running | "A payment is still going through. Try again in a moment." |
| A handoff is already running | "Another move is in progress." |
| A wallet that stays home | "<wallet> can't be used here. Use it on <device>." and, for Ark and Bark, "Coins expire on <date>. Use Ghostly on <device> before then." (a notice, not a failure) |
| Coins about to expire | "Renew your <wallet> coins first." |
| The turn cannot be read | "Can't check which device is active. Check your connection." |

**Forced takeover**

- "Take over without <device>?" One line: "This device has your profile as of <date>." ⓘ: "Messages and money that reached <device> after that are not here. If <device> comes back, it stops." and one line per wallet ("Cashu: 12 000 sats here, checked with the mint when you take over").
- "Lost or stolen?" with "Lost or stolen" and "Just broken or wiped". On the first, after the takeover: the money checklist, then "Remove <device>".
- The person types the device's name to confirm. Button: "Take over".

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
- **The device link can wake a phone.** Each device with a push subscription shares its target with the person's other devices over the device link. A desktop asking a suspended phone for a handoff posts a push to it: "<device> wants to take over. Open Ghostly."
- **Storage.** On iPhone and iPad the Home Screen install gates enrollment. Elsewhere a refused `persist()` is a warning, not a stop. If a phone's storage is cleared while it is active, the frozen copy on the other device and a forced takeover are the recovery, which is why phase 1 always keeps one.
- **Background.** A phone suspends the web app in the background, so a handoff runs with the app in front (a screen wake lock, "Keep Ghostly open"). Pass 1 resumes after an interruption.
- **Platform floor.** Push needs iOS 16.4; a non-extractable device key needs Safari 17. Below that the device key is a stored seed.

## Security and privacy

### Threats

| Threat | What limits it | What remains |
|---|---|---|
| A stolen standby with a frozen copy | The device's own lock and disk encryption. Removal closes the turn and the device links to it | **The copy is not encrypted by Ghostly**: seeds are sealed with a key stored beside them ([202](202-arkade.md), persistence), and the lock password is a screen gate. Everything in the copy is readable and usable until money is moved and chats are paired again |
| A stolen standby with no copy | It holds `D` and a device key, nothing of the profile. A pull needs the lock password: 5 tries an hour, 15 in all | A weak password guessed within the limit. The device names in the turn record |
| A few minutes at the unlocked active device | Adding a device asks for the lock password; the digits must be confirmed there; every device shows the device list; a new device raises a notice on the active one for a day | With the password known to the attacker, an enrolled device that can pull later. A backup export has the same reach, once |
| A holder of a backup made after enrollment | It has `D`: it can read the turn record and take over | By design: a backup is the profile. Removal moves the set to a new `D`, after which that bundle can only start a separate copy |
| A relay operator hides or replays the turn record | A lower sequence cannot replace a higher one on an honest node; Desktop also reads the DHT | Web and extension read one operator by default. A device that is shown only old records is not told it was replaced |
| A photographed enrollment code | One session per invite; digits only after the inviter's proof; the code holds no long-lived secret (links are derived from `D`) | The attacker can make the person's own attempt fail; the person starts again |
| A hostile holder of `D` raises the turn or replaces the tombstone | Shown on every device as taken without a release; "It wasn't me" takes it back and moves to a new `D`; the tombstone is put again hourly | The honest device is stopped until the person reacts |
| Cloned storage | The `instance` in the record | A window until the first-started copy reads |
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

- the record's bytes, test vectors, every refusal of the reader, the sequence formula, the tombstone;
- the read algorithm against sources that disagree, lag, refuse and time out; a refused conditional put is never sent again without its condition;
- the handoff state machine with a kill at every step on each side, covering every row of the crash matrix, and **power loss** after the release write;
- an equal-sequence record from a clone;
- the password proof: wrong password, the attempt limits, a replayed message;
- enrollment: a second joiner, a wrong proof, digits withheld until the proof, an invite past its time, an old app given a version 2 code;
- the gate: a standby starts no wallet, publishes no DID or proof record, reads no mailbox, and is skipped by profile peek, on web, extension (browser start with no page) and Desktop;
- raised counters across a group epoch change and a new community head; edits and pins untouched;
- a stale admin: after a forced takeover a member's leave produces no commit, and door duty is refused;
- a stale USDT attempt is not broadcast after a forced takeover or a restore; a stale BDK copy rescans;
- a stale Breez database is gone after a release and a return;
- an old build opening storage written by this version shows the newer-version notice and starts nothing;
- a bundle made before enrollment, restored in this version, finds the record.

End to end:

- two browser contexts as two devices plus a contact: enroll, pull, push, cancel at each step, resume after a dropped link;
- Desktop to web and back, with files over 64 MiB and a file left for later;
- partitioned relays (each device sees a different relay) during a forced takeover;
- for each wallet type that moves: a funded Testnet wallet there and back with the balance conserved, and a forced takeover from an old copy with the result its row states;
- a soak, before any Mainnet wallet moves: two devices switch back and forth a few hundred times while a contact and a group send messages, files and Testnet payments; at the end no message is lost or doubled, balances add up, every counter a contact saw only grew, and the relay log shows one writer per record at a time.

And: a security review of the implementation ([docs/SECURITY-REVIEW.md](../SECURITY-REVIEW.md)) before the release, and the measurements of [Measured, and still to measure](#measured-and-still-to-measure) written into this document.

## Compatibility and rollout

**Contacts, on any version.** No frame, record or capability of a chat or a group changes. A handoff looks like an app that restarted. A contact on 1.0.x sees, after a forced takeover only, the hold line and the missing-frame count of [Raised counters](#raised-counters), once.

**Old app versions on the person's own devices.**

- An older build must never start a frozen copy. The first release with this WISP **raises `DB_VERSION`** (`packages/browser/src/shared/idb.ts`; 11 on `dev` today), so an older build that opens that storage gets a version error, shows the newer-version notice and starts nothing. The Desktop's own files get the same version step.
- A bundle that carries a device set has **envelope version 2**. The envelope check is the strict one ("This backup comes from a newer Ghostly; update to restore it", `packages/browser/src/backup/envelope.ts`); a higher payload version would answer "does not hold a profile".
- A bundle made **before** enrollment has envelope version 1 and no device set. An app with this WISP still guards it, through the `D` derived from the DID key. **An app from before cannot be stopped** from restoring it as a live second copy; that is today's risk, unchanged, and the client says so when a device set is made: "Backups made before today can still start a second copy in an older Ghostly."
- Enrollment codes are a new invite version, which an older app must refuse.

**Record and wire changes, all additive.**

| Change | Who sees it |
|---|---|
| A new Pkarr record under a new key, with a counter as its sequence number | The person's devices, relays and DHT nodes |
| Device links: ordinary paired sessions on derived keys, with capabilities `enroll/1` and `handoff/1` and their frames | The person's devices only |
| Invite version 2 | The person's devices only |
| The backup envelope version 2 when a device set is inside; never a device key | Backups |
| `DB_VERSION` raised; an index on the files store by digest; the `ghostly-devices` database | One device |
| A conditional put (`cas`) in the Desktop's DHT client and a turn path of its own in the relay client | Code only |
| Phase 2: a `handoff/` folder and a multipart object in the storage layout ([1000](1000-storage.md)) | The person's storage |

### Phase 1 (targets 1.1)

Phase 1 is the daily story: the desktop at home, the phone outside, both able to be on at the moment of the switch. It contains, as pieces that can each be a pull request:

1. **Device state and the gate.** The `ghostly-devices` database with strict writes (and the Desktop's fsynced file); the gate in front of `start()` on web, extension and Desktop; device-link-only mode; profile peek skipping standbys; `DB_VERSION` raised.
2. **The turn record.** The binary codec with vectors; the reader; the conditional put and the read of every source, in TypeScript and in the Desktop's Rust (`cas`); the checks and limited mode; `instance` and clone detection.
3. **Device keys and derived links.** Non-extractable where it exists, a seed elsewhere; link derivation; device keys as participation keys with trust on first use off.
4. **Enrollment.** Invite version 2; `enroll/1`; the digits; the 8-character lock password; the iOS install gate and the `persist()` warning; the first-run "I already use Ghostly" screen.
5. **The handoff.** `handoff/1`; pull and push; the password proof and its limits; two passes; skip by digest (the new index); files left for later and fetched over the device link; staging and install; the crash matrix; versions in the first frame; the progress and failure screens.
6. **Forced takeover and the restore guard.** Raised counters and the group floor; admin work off; signed bytes parked; the BDK rescan; the first `D` from the DID key; envelope version 2; the superseded screen.
7. **Remove a device.** The new `D`, its delivery over the old links, the tombstone, the "Lost or stolen?" checklist.
8. **Wallets.** The single-writer rule behind a fresh turn read; Cashu's `moved` mark, lock drain and proof check; Spark's database deleted on release; home devices, the "On <device>" cards and the expiry dates and refusals; the per-type Testnet tests.
9. **Push.** The phone's target kept by the active device; the standby worker's quiet notices; the wake push over the device link; "Keep this computer awake" on Desktop.
10. **Devices on the Profile page**, the standby screens and the switcher's "Standby".

**Moves in phase 1:** chats, messages, files, groups, identities, the DID, settings, storage settings, and these wallets: Cashu, Spark, Lightning through NWC and Core Lightning, LND without a pinned certificate, on-chain BDK (Testnet only as today), and Arkade once its move test passes. Testnet wallets of these types move from the first release; a Mainnet wallet of a type moves once that type's two tests pass and the soak has run.

**Stays home in phase 1:** Bark, Fedimint, USDT, LND with a pinned certificate, Bitcoin Core, and Arkade until tested.

**Honest limits of phase 1:**

- Both devices must be on, with Ghostly open, at the switch. A desktop asleep at home cannot hand over; "Keep this computer awake" and "Move to <device>" at the door are the ways around it. There is no pickup from storage yet.
- The first move to a device copies every file. Later moves copy only new files and the database.
- A pull asks for the lock password every time.
- A frozen copy is kept on every device that was active, unencrypted. A lost phone means Remove, the money checklist and pairing chats again.
- After a forced takeover, what only the lost device had is not here, groups are not managed from the new device until the person says so, and a payment that was signed but not confirmed waits for a decision.
- Some wallets stay on the desktop, and Ark or Bark coins there need the desktop to be the active device every few weeks.
- A device that cannot read the turn record does not start by itself.
- CLI profiles are not part of it.

### Later phases

| Phase | What it gives |
|---|---|
| 2 | Prepared handoff naming its taker, through S3-compatible storage or a local file; "Keep no copy here"; "Send what is only here"; the guided money flow; Bark, Fedimint and USDT moving as their tests pass; `ghostly device` commands for moving a CLI profile between servers, if still wanted |
| 3 | Incremental handoff by change numbers |
| 4 (optional) | Contacts refuse a superseded device; participation-key rotation ([02](02-peer-keys.md)) |

## Why not two live devices

It is the natural next wish, so the reasons are written down. Two live devices need: a device key per chat known to each contact, so the contact can send to both and tell them apart (every chat record and the session handshake change, and old contacts cannot follow); delivery of each message to every device, with no server to fan it out; group counters and admin commits per device; and wallets with two writers, which Cashu proofs, Fedimint clients and Spark leaves do not allow. One active device with a handoff needs none of that and keeps every existing format.

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
| Device links | Derived from `D` and the device keys |

**Still open, for the owner:**

1. **Mainnet money.** The rule above lets a wallet type move on Mainnet once its two Testnet tests and the soak pass. Recommendation: keep that rule, and let the owner say go per type; the first release may well ship with Mainnet Cashu and remote Lightning only.
2. **"Start anyway" when the turn cannot be read.** It keeps the person's chats usable on a bad network, in limited mode, at the cost of a possible double-active window for messages. Recommendation: keep it, on Desktop and web alike; the alternative is a profile that will not open whenever both relays are down.
3. **A turn record for every profile, even with one device.** It costs one more key and one hourly put per profile, and it would let a restored backup always find out that the original still runs. Recommendation: yes, in phase 2, once the record has run in the field.
4. **Readable history on a standby.** Recommendation: not yet. It is useful, but every screen that reads history would need proof that it starts nothing, and the gate's strength in phase 1 is that it opens no database at all.
5. **Participation-key rotation** as its own WISP. It is the real answer to a lost device that held a copy. Recommendation: design it alongside phase 2.

## Conformance (candidate)

A client that implements this WISP MUST:

- keep a device key that is in no backup and no handoff;
- read the device state before starting anything, and in any state but `single` and `active` open no profile database and publish nothing but the turn record and device-link rendezvous;
- write `standby` with strict durability before it signs a release, and name the taker in every release;
- start as active only with a verified state, a stored release and its own turn read back, or after an explicit forced takeover;
- use `turn * 2^20 + rev * 4 + author` as the turn record's sequence number, put a stored record byte for byte, make every raising put conditional, and never repeat a refused put without its condition;
- read the turn from every source it has, and stop at once on a higher turn, a foreign `instance` or a tombstone;
- open a single-writer wallet SDK, spend real money, sign a group commit or take door duty only after a good turn read under 60 seconds old;
- after a forced takeover or a restore: raise exactly the listed counters, keep admin work off until the person turns it on, and never broadcast saved signed bytes;
- never open a wallet database it holds as a frozen copy;
- send enrollment and handoff frames on a device link only, admit one session per enrollment invite, and show digits only after the inviter's proof;
- require the lock password for a pull and limit attempts.

## References

[Profiles](04-profiles.md), [backups](05-backups.md), [peer keys](02-peer-keys.md), [invites](800-invite-join.md), [store-and-forward](4xx-store-and-forward.md), [storage](1000-storage.md), [payments](200-payments.md), [wallets](../WALLETS.md), [DHT delivery](../DHT-DELIVERY.md), [the web app](../WEB.md). [BEP 44](https://www.bittorrent.org/beps/bep_0044.html) for the sequence number and `cas`; [Pkarr](https://pkarr.org); [RFC 9383](https://www.rfc-editor.org/rfc/rfc9383) (SPAKE2+).

## Revision log

One file per change in [changes/06-devices/](changes/06-devices/) ([how](00-process.md#revisions)). The site lists them here, newest first, and derives the Revision and Updated rows from them.
