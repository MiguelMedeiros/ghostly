# WISP 06: One Profile on Several Devices

| Field | Value |
|---|---|
| Candidate number | 06; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [01](01-ghost-core.md), [02](02-peer-keys.md), [03](03-capabilities.md), [04](04-profiles.md), [05](05-backups.md), [200](200-payments.md), [400](400-chat.md), [401](401-paired-chat.md), [403](403-dht-text.md), [4xx store-and-forward](4xx-store-and-forward.md), [501](501-paired-files.md), [900](900-group-sessions.md), [1000](1000-storage.md), [1002](1002-s3-storage.md), [11xx](11xx-headless.md) |
| Implementation | None. A design proposal: nothing in this document is built, and the owner has not yet confirmed its three first open decisions |
| Summary | Use one profile on a desktop and a phone: one device is active at a time, and one button moves everything to the device in your hand. |
| Availability | Planned |
| Notes | Proposal for review, not built. Planned after 1.0.2. Two devices live at once, server accounts and background sync are out of scope. |

> This is a review draft. Candidate numbers and new record formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md) and [implementation evidence](IMPLEMENTATION.md).

Number note: legacy reader paths once used `06` for WebRTC (now [101](101-webrtc.md)). Per the [numbering map](NUMBERING.md), the current number takes precedence, as for [04](04-profiles.md) and [05](05-backups.md).

## Purpose

A person wants the same Ghostly profile on the desktop at home and on the phone when away: the same chats, groups, identities and wallets, and a way to say "I am using this one now". Today the only way to get a profile onto a second device is to restore a backup there ([05](05-backups.md)), which makes two live copies of the same keys and the same money. [05](05-backups.md) warns about it ("Treat a bundle as a move"), [02](02-peer-keys.md) lists "multi-device policy" as open, and [1000](1000-storage.md) asks whether "sync between one person's devices" belongs to storage. This document answers with the smallest model that is safe:

- a profile can be **enrolled** on several devices;
- exactly one of them is **active**; the others are on **standby** and do nothing on the network for that profile;
- a **handoff** moves the whole state to another device and makes it the active one;
- a counter, the **turn**, tells every device which one is active, so a device that was replaced stops.

## Goals and non-goals

In scope:

- The same profile on a desktop app, a web app, an extension and a phone (the installed web app), switched when the person asks.
- Everything comes along: chats, messages, files, groups, identities, settings and (by decision 2) wallets.
- A device that is lost can be taken out, and a remaining device can take over.
- Contacts see nothing new: no new frame, no new record of theirs, no "new device" notice.

Out of scope, on purpose:

- **Two devices live at once** (true multi-device, as messengers with a server do it). It needs per-device keys known to contacts, fan-out of every message, and wallets that tolerate two writers. None of the three exists here; see [Why not two live devices](#why-not-two-live-devices).
- **A server-side account.** There is no Ghostly server; the only shared places are the DHT and the person's own storage.
- **Automatic background sync.** State moves when the person presses a button, never by itself.
- **Merging two histories.** State has one writer at a time, so a handoff copies; it never merges, except for the narrow recovery in [After a forced takeover](#after-a-forced-takeover).

## What exists today (evidence)

The design rests on these facts of the code on `dev`. Where one is wrong, the section that cites it must change.

| Fact | Where |
|---|---|
| There is no profile-wide key and no device identity. Every chat has its own rendezvous seed, invite secret and participation seed. The only profile-wide key is the DID key, which no chat uses and no contact reads routinely | `packages/browser/src/shared/types.ts` (`StoredLink`), [3xx did:dht](3xx-did-dht.md#the-key), `packages/browser/src/engine/did.ts` |
| Every Pkarr packet of a chat is signed with a sequence number that is the wall clock in microseconds, nothing persisted: with two publishers the last one wins | `packages/core/src/pkarr.ts` |
| Inside the packets there are persisted counters: the DHT mailbox `sequence` and `peerSequence`, the capability record `rev`, the hold pointer `pointerRev`, `outSeq`, `inSeq`, `peerAck`. A reader drops anything at or under its high-water mark, silently | `packages/core/src/dhtDelivery.ts`, `capsRecord.ts`, `packages/browser/src/engine/hold.ts` |
| A group member has a send counter per epoch, and a frame is accepted once per (sender, epoch, sequence). An admin that signs two different commits after the same parent forks the group, and a forked group halts | `packages/core/src/groupSession.ts`, `groupCommunity.ts`, [9xx mesh](9xx-group-mesh.md#membership-chain) |
| There is no ratchet and no app-layer session key: a chat continues with its five stored keys. All sealing uses random 24-byte nonces, so old state never causes nonce reuse | `packages/core/src/pairedSession.ts`, `crypto.ts`, `groupCrypto.ts`, [02](02-peer-keys.md) |
| A dial-in from the pinned contact while a session is held replaces that session (an app that restarted). Two instances with the same keys running at once make the contact refuse one as crossed, "and the chat stops" | `packages/core/src/ghostlink.ts` (`attachReplacement`), `apps/desktop/src/single_instance.rs`, [100](100-transports.md) |
| The only guards against two copies are local to one machine: the `ghostly-peer` Web Lock, the extension's offscreen document, the Desktop single instance, the CLI's `daemon.lock` | `packages/browser/src/inPageHost.ts`, `packages/cli/src/profiles.ts` |
| A backup carries the whole peer database and local keys, files up to 16 MiB, each Ark database; it leaves out the Bark databases, the Fedimint client files, the Breez database, the backup and hold storage credentials and the push subscription. A restore marks unfinished payment intents `unknown` and rewrites nothing else | `apps/ui/src/lib/profileBackup.ts`, [05](05-backups.md) |
| The push subscription is per browser and per profile, and a contact learns it only on a live session | [401](401-paired-chat.md#wake-up-push), `packages/core/src/pairedWake.ts` |
| Nothing asks the browser for persistent storage (`navigator.storage.persist` is not called) | whole repository |

Three consequences shape everything below. First, **the brief's "turn field in the profile's signed record" has no record to live in**: there is no profile record, so the turn needs a key and a record of its own, read by the person's own devices and by nobody else. Second, **the per-record sequence numbers are no lock**: they are clock time, so a stale device that publishes simply wins. The turn is the only lock. Third, **moving state breaks no key chain** (nothing ratchets), but **rolling state back is harmful**: a device acting on older counters is dropped silently by contacts, and an admin doing so can halt a group. The handoff therefore moves counters exactly, and the one path that cannot (a forced takeover) jumps them forward.

## Model

### Terms

- **Device**: one install of a client holding (or able to hold) the profile: a Desktop app, a browser's web app, an extension, a CLI profile folder. Two browsers on one machine are two devices.
- **Device key**: an Ed25519 key made on the device and never copied off it. It is not in a backup and not in a handoff. Where the platform can keep a key that cannot be exported (the OS keychain on Desktop, a non-extractable WebCrypto key where Ed25519 is supported) the client SHOULD use it. Whether every WebKit version in use can do so is not checked yet.
- **Device set**: the devices enrolled in one profile, at most 4. It has one secret, the **device-set secret** `D` (32 random bytes), which every enrolled device holds and nobody else. `D` is made when the second device is enrolled; a profile on one device has none and publishes nothing new (but see [open question 7](#open-questions-for-the-owner)).
- **Turn**: a counter. The device that holds the highest turn is the active one.
- **Device link**: an authenticated encrypted channel between two of the person's own devices. It is an ordinary paired chat session ([401](401-paired-chat.md)) with its own keys, made at enrollment, marked as the person's own and never listed among chats. It reuses the transports ([100](100-transports.md)) and the file transfer ([501](501-paired-files.md)) as they are.

The profile's chat keys alone never decide who is active. Being active takes three things: `D` (to write the turn record), a device key listed in the device set (to sign it), and for a normal handoff a **release** signed by the device key of the device that was active before.

### States of a device

| State | Meaning | What it does on the network for this profile |
|---|---|---|
| `single` | The profile has no device set (today's behaviour) | Everything, as today |
| `active` | Holds the turn | Everything, plus the turn record |
| `standby` | Enrolled, not active. Holds either nothing but its device key, `D` and its device links (an **empty standby**), or also a **frozen copy** of the state as it was when it last released | Reads the turn record. Answers its device links. Nothing else: no presence, no chat, no group, no wallet, no DID, no proof record |
| `released` | Was active, prepared a handoff and stopped; nobody is active until a device picks it up | As `standby` |
| `superseded` | Finds a higher turn that it did not release | As `standby`, and offers the recovery of [After a forced takeover](#after-a-forced-takeover) |
| `removed` | Taken out of the device set | Nothing |

The state is a durable local record of the profile, written before any step that depends on it. The engine reads it before it starts anything: a profile that is not `single` or `active` starts no chat, no group, no wallet SDK and no timer that publishes.

### Adding a device

Today's path is a backup restored on the second device. It copies every secret through a passphrase file, leaves the first copy running, and nothing tells either copy about the other. Enrollment replaces it:

1. On the active device: Settings, Devices, **Add a device**. It makes a one-time **device invite** (the invite format of [800](800-invite-join.md), with a flag that says "own device", valid 10 minutes, usable once) and shows it as a QR code and a code to copy. On the first enrollment it also makes `D`.
2. On the new device, with no profile or beside others: **Add this device to my profile**, then scan or paste. It makes its device key and joins. Both sides pin each other's participation key for the device link as any chat does.
3. Both screens show the same six digits, taken from the session transcript and both device keys. The person confirms on the active device that they match. This is what stops an invite photographed over a shoulder: the first to use the invite gets the link, and the digits show that the device that got it is the one in the person's hand. Without the confirmation nothing is sent.
4. The active device sends, on the device link: `D`, the device set (each device's key and name), the current turn, and the hold storage settings with their credentials when the person has set them (see [The offline path](#the-offline-path-a-prepared-handoff) for why this exception to [1000](1000-storage.md) is made). It publishes the turn record with the new device listed.
5. The new device is now an **empty standby**. It holds no chat key and no wallet. It becomes useful with its first handoff, which the person can start at once ("Use on this device") or later.

Enrollment transfers no profile state. The whole state travels only in a handoff, under the rules of [The handoff](#the-handoff).

### A backup restored where a device set exists

A backup of an enrolled profile carries `D`, the device set and the turn it was made at. It never carries a device key (stripped like the push subscription and the storage credentials are today). So a restored copy knows it belongs to a device set and has no device key in it. The client then:

- reads the turn record before it registers the profile as usable;
- if a device is active there, does **not** start the copy. It says the profile is active on another device and offers **Add this device instead** (enrollment, then a handoff, which is the safe path), **Take over** (a [forced takeover](#forced-takeover), for when the other devices are gone) or **Cancel**;
- if it cannot read the record (no relay answers), does not start the copy either, and says so. Take over stays available with its warning;
- treats a start from a bundle as a forced takeover in every case: the bundle is older state, so the outgoing counters jump ([Counter stride](#counter-stride)).

The same-device check of [05](05-backups.md#restoring-on-the-same-device) (a bundle matched to a profile by a chat key or the DID key) stays as it is. A profile with no device set restores as today, with today's risk; [open question 7](#open-questions-for-the-owner) proposes closing that too.

### Removing a device

On the active device: Settings, Devices, Remove. The client:

1. makes a new device-set secret `D'` and so a new turn record address;
2. publishes a last record at the old address, a **tombstone**, at the highest sequence number the DHT takes, so nobody holding the old `D` can replace it. It says only "this address is closed". The active device keeps it alive (an hourly put) for as long as the profile exists, because a removed device that was merely stale must find it whenever it comes back;
3. sends `D'` to the remaining devices over their device links (a device that is off gets it at its next link, and shows "Open Ghostly on <active device> to finish" meanwhile);
4. deletes its device link with the removed device, so a pull from it is refused.

What removal can and cannot do depends on what the removed device held:

| The removed device was | A thief with it unlocked can | Cannot | What the person should do |
|---|---|---|---|
| An empty standby | Read the old turn record (device names, the turn). Ask for a handoff until removed, which the lock password stops when one is set ([Authorizing a pull](#authorizing-a-pull)) | Read a message, reach a contact, touch money | Remove the device. Nothing else |
| A standby with a frozen copy | Read all history up to its last release. Read the hold storage (it has the credentials). Act as the person to every contact, read new DHT texts and held items (they are sealed to the chats' static keys), and spend from every wallet whose seed or credential is in the copy. The app's own turn check does not bind a modified app | Take the turn under `D'` | Remove the device, change the storage keys, move money, and re-pair chats (below) |
| The active device | The same, with current state | The same | Force a takeover from another device, then the same |

The honest limit: **removal protects the turn, not the keys.** Chats have no key rotation ([02](02-peer-keys.md) leaves it open), so a copied chat key stays valid until the chat is paired again. The remedies and their cost:

- **Money first.** Cashu: swap every proof at its mint (cheap, and the thief's copies become spent). Wallets with a phrase (Ark, Bark, Spark, Fedimint, on-chain, USDT): make a new wallet and send the funds to it (network fees). Remote Lightning (NWC, Core Lightning, LND): revoke the connection, rune or macaroon at the node. The client offers this as one guided step, "Move money to new wallets".
- **Chats.** Each chat is paired again with a new invite; the contact sees a new chat. For a group, the admin removes the member key and adds a new one (a new epoch). This costs every contact an action, so the client says it plainly and does not pretend removal is enough.
- **Later.** A participation-key rotation bound to the old key ([02](02-peer-keys.md), candidate key lifecycle) would let a chat move to a new key without a new invite. It is the right fix and is not designed here.

This is why a phone, the device most likely to be lost, should be able to keep nothing while on standby ([open question 4](#open-questions-for-the-owner)).

## The turn

### Record

The turn record is one Pkarr packet under a key only the person's devices can derive:

- turn identity: `identityFromSeed(HKDF-SHA256(ikm = D, salt = "ghostly-devices/1", info = "turn", 32))`;
- seal key: `HKDF-SHA256(ikm = D, salt = "ghostly-devices/1", info = "turn-seal", 32)`;
- one TXT record `_turn` = `nonce(24) || XSalsa20-Poly1305(sealKey, nonce, plaintext)`, base64url;
- `plaintext = JSON([body, signature])`, padded with spaces to one fixed length so the packet has the same size whatever it says (as [403](403-dht-text.md#what-a-mailbox-shows-revision-07) does);
- `body = [1, turn, rev, active, devices, release]`;
- `signature = base64url(Ed25519(deviceKey of the author, utf8(JSON(["ghostly-turn", turnAddress, body]))))`.

| Field | Meaning | Bound |
|---|---|---|
| `turn` | The counter. Starts at a random value under 2^32 chosen with `D`, so its absolute value says nothing | Safe integer, never decreases |
| `rev` | Increases with every change inside one turn (a device added, renamed) | Under 2^20 |
| `active` | The device key of the active device, or `null` while a prepared handoff waits | 32 bytes, base64url |
| `devices` | `[[deviceKey, name], ...]`, the device set | At most 4; a name at most 16 UTF-8 bytes |
| `release` | `null` for the first turn and for a forced takeover. Otherwise `[from, digest, object, signature]`: the device that gave the turn up, the digest of the state it handed over, the name of a stored snapshot or `null`, and `from`'s signature over `["ghostly-turn-release", turnAddress, turn, to, digest]`, where `to` is the taking device's key, or `null` when any enrolled device may take it | One |

The packet MUST fit 1,000 bytes. If it does not, the author shortens names; it never drops a device. Exact bytes and test vectors are a blocker before Proposed, as for the capability record.

**The BEP44 sequence number is `turn * 2^20 + rev`, not the clock.** This is the one place where Ghostly would use a counter there, and it is what makes the record a lock: a DHT node and a Pkarr relay refuse a packet whose sequence number is lower than the one they hold (measured for the DID with the `pkarr-relay` 2.0.2 binary: an older packet answers 409, [3xx did:dht](3xx-did-dht.md#publishing)). A stale device that tries to put its old record back is refused and learns from the refusal that it was replaced. Nothing compares two devices' clocks. To be checked before this is relied on: that the Desktop's Rust Pkarr client and both relay operators accept a sequence number that is not a timestamp (the DID's seconds suggest yes), and what a node does with two different packets at the same sequence number (see [Two devices taking at once](#two-devices-taking-at-once)).

A reader accepts a record that opens under `D`, is signed by a device key listed in its own `devices`, carries a turn not lower than the highest it has seen, and, when `release` is present, whose release is signed by a key the reader knew as a device of the set. Holding `D` is the authority to write; the device signature says who wrote, and the release says the previous holder agreed. A record that fails leaves the last good one in force.

### Who may raise the turn

- The device that takes a normal handoff, with the release of the device that was active.
- A device that picks up a prepared handoff, with the open release (`to` is `null`) the releasing device published.
- A device that forces a takeover, with no release. The record then says so (`release` is `null`), and every other device shows it.

Each needs the person to press a button on the taking device. Nothing raises the turn by itself.

### When a device checks

A relay read is not free: the web app and the extension share 30 requests a minute per relay with every chat ([04](04-profiles.md#checking-other-profiles)). So the turn is not read before every send. An active device reads it:

- at start, before the engine starts anything for the profile;
- when the app comes back to the front, the network changes, or the machine wakes;
- every 10 minutes (with jitter) while it runs, and it puts its record again every hour, which doubles as a check since a lower sequence is refused;
- before a Mainnet spend, when its last good read is older than 60 seconds;
- at once on a hint: a device link that says "I took the turn"; a put of its own record refused as older; one of its own chat records (its capability record or mailbox) found with an inner counter higher than its own, which means another copy is writing; a contact's session replaced by another dial-in where the transport reports it.

A hint is never authority. A contact or a relay cannot make a device give the turn up; it can only make it read the record.

A standby device reads the record when its screen is opened and every 10 minutes while it shows, to say which device is active.

### When the record cannot be read

- **Active, no relay answers.** The last good record stays in force: the device goes on with chats (it could only have been replaced by a forced takeover, which the person did knowingly on another device). It does not spend Mainnet money until a read succeeds. This trades a possible double action on messages for not locking the person out of their chats whenever relays are down.
- **Active, relays answer and hold nothing** (the record expired while every device was off). The device puts its record again and goes on.
- **Standby or released.** Never acts, whatever it reads or fails to read.

### When a device finds itself superseded

At once, in this order: it writes `superseded` durably; closes every session without sending anything new; stops every timer that publishes (presence, capability records, mailboxes, hold pointers, the DID, proof revocation records, group beacons); closes every wallet SDK so no background job runs (Ark renewal, Bark refresh, Breez sync, Fedimint watchers); and shows the superseded screen. It keeps its state as it is. Unsent messages and money it holds that the new active device may lack are handled in [After a forced takeover](#after-a-forced-takeover).

### Failure cases

| Case | What happens |
|---|---|
| Normal handoff, old device then goes offline for a month | Nothing to do: it wrote `standby` before it signed the release, so it never acts again without a handoff back |
| Forced takeover while the old device is off; it comes back with unsent messages and money the snapshot lacked | It reads the higher turn at start, before the engine starts, and becomes `superseded` without publishing. It offers to send what only it has to the active device |
| The same, but it comes back with no relay reachable | It was `active` in its own eyes, so it goes on with chats until a read succeeds (at most the time relays stay unreachable to it). In that window both devices act. See [What is and is not guaranteed](#what-is-and-is-not-guaranteed) |
| Clocks wrong by days on either device | No effect on the turn. A clock far in the future still makes that device's chat packets win over the other's during a double-active window, as today |
| A relay hides the new record or serves the old one | The device reads at least two relays (and the DHT itself on Desktop) and takes the highest turn. A relay set that all lies keeps a stale device acting; only hints can break that |
| A buggy standby that publishes chat records | Contacts see state flap as with two live copies today. The active device notices its own records carrying counters it did not write, reads the turn, finds itself still active, and reports "Another copy of this profile is acting" with the device list. It cannot stop the other copy |
| A hostile enrolled device (stolen, with `D`) raises the turn | The real device becomes `superseded`. Its screen says another device took over on its own and offers **It was not me**: take the turn back (a forced takeover) and remove that device. Until then the thief's copy is "active", which matters only to honest devices: a thief with a frozen copy needs no turn to misuse keys |
| The device set's storage was copied (a disk image, a phone backup restored to a new phone, a browser profile folder copied) | Two installs now share one device key and one state, both `active`. Neither turn nor release can tell them apart. The 10-minute check does not help either, since the record names "their" key. Only the self-check on chat records detects it. This is today's "two live copies" and stays a limit |

### What is and is not guaranteed

**Guaranteed** (given devices whose storage is not copied or rolled back from outside, and an unmodified app): after a normal handoff or a prepared handoff, **at most one device is active at any moment**, with no dependence on relays, clocks or timing. The old device makes itself standby durably before it signs the release, and the new one starts only once it holds that release and has verified the whole state. Between the two there may be a moment with no active device, never two.

**Detected, not prevented** (bounded by the next successful read of the turn record, at most about 10 minutes while relays answer):

- a forced takeover while the old device is still alive somewhere;
- a start from a restored backup, when the person chooses Take over;
- two takers of one prepared handoff across relays that do not see each other.

In such a window both devices may send, publish and, on Testnet, spend. Mainnet spends are held back by the 60-second rule on any device that can read the record, and blocked on one that cannot.

**Not guaranteed:**

- anything against a device whose app was modified or whose storage was cloned;
- that a relay shows the newest record;
- that contacts enforce anything: they cannot see the turn (next section).

### Should contacts refuse a superseded device?

They cannot today: a contact sees chat keys, and both devices hold the same ones. To let a contact refuse the old device, each chat would carry a number that only grows with handoffs: a new optional element in `pair-offer` (inside the signed transcript), in the capability record and as a trailing element of the mailbox envelope, with the rule "refuse a lower one than the highest seen". Old readers ignore unknown trailing elements ([03](03-capabilities.md#layer-0-capability-record)), so it would be compatible, and it needs no device key on the wire.

It is left out of the first phases for three reasons. It tells every contact when the person changes device, and how often. It changes three formats and the group frames would need the same. And it guards only messages: wallets, where double action costs money, talk to mints and servers that know no turn. It is listed as an optional later phase and as [open question 8](#open-questions-for-the-owner).

## The handoff

### Shape

A handoff is a copy with one writer, in six steps. The device that takes is `B`, the active one `A`, the turn `N`.

1. **Ask.** The person presses **Use on this device** on `B`. `B` dials `A` on their device link and sends `handoff-request` with what it already has (see [Incremental handoff](#incremental-handoff)).
2. **Quiesce.** `A` stops taking new sends, lets work in progress end or parks it ([Payments in flight](#payments-in-flight)), says `paired-bye` on its chat sessions so contacts end them at once ([401](401-paired-chat.md#liveness-and-reconnection)), stops publishing, and closes its wallet SDKs so their databases are complete on disk. `A` still holds the turn: if anything fails from here to step 5, it starts again as the active device and nothing was lost.
3. **Stream.** `A` sends the state as a **streamed sealed backup** ([05](05-backups.md); the streaming format is being designed separately, and this document needs only that a backup can be written and read as a stream of parts), over the file transfer of [501](501-paired-files.md), which already resumes from confirmed bytes after a drop. A manifest lists every part with its size and SHA-256; the digest of the manifest is `H`. Both screens show progress in bytes.
4. **Verify.** `B` writes into a staging area, never into a live profile, checks every part against the manifest, checks it can read the database version (it refuses a newer one: "Update Ghostly on this device first"), and answers `handoff-verified` with `H`, signed with its device key.
5. **Release.** `A` writes `standby` durably (released turn `N` to `B`, digest `H`), **then** sends `handoff-release`: its signature over `["ghostly-turn-release", turnAddress, N + 1, B, H]`. From the durable write on, `A` is on standby even if the frame never arrives.
6. **Take.** `B` stores the release durably, moves the staged state into place, publishes the turn record at `N + 1` with the release, and starts the engine. It tells `A` (`handoff-done`); `A` then applies the "on standby" column of the table below.

**Cancel is safe until step 5.** The turn changes only after `B` has verified the whole state. A drop between 5 and 6 leaves nobody active: when the devices meet again `A` sends the same release again, and `B` finishes. If `B` is gone for good at exactly that point, `A` can take the turn back with a forced takeover from its own state, which is the state `B` would have had.

The frames (`handoff-request`, `handoff-verified`, `handoff-release`, `handoff-done`) exist only on a device link, under a capability `handoff/1` that only device links offer. No contact ever sees them, so nothing changes for old peers.

### Authorizing a pull

The active device is often unattended (the desktop at home while the person is out), so it cannot ask for a confirmation. What authorizes a pull is the device link itself (the pinned key of an enrolled device, confirmed by the six digits at enrollment) and, when the profile has a lock password ([04](04-profiles.md#security-and-privacy)), **that password, typed on the taking device and proven to the active one** without sending it (a password-authenticated key exchange; which one is a decision before Proposed). Without it, a stolen empty standby could pull the whole profile. A profile with no lock password is told so when it adds a device: "Anyone holding an added device can move this profile to it. Set a lock password to prevent that."

### What moves

Columns: whether it moves; whether it must arrive exactly once and in full (a counter or a secret that two devices must never both use); whether it could be rebuilt without the other device; what the device that goes to standby does with its copy when it keeps a frozen copy (an empty standby wipes all of it).

| State | Moves | Exactly once | Can be rebuilt | On the device that goes to standby |
|---|---|---|---|---|
| Device key | Never | n/a | n/a | Kept |
| `D`, device set, device links | Not in the stream (enrollment gave them) | n/a | By enrolling again | Kept |
| Chats: rendezvous seed, invite secret, participation seed, pinned contact key, trust | Yes | Secrets | No: lost keys end the chat | Frozen |
| Per-chat counters: mailbox `sequence` and `peerSequence`, capability `rev`, hold `pointerRev`, `outSeq`, `inSeq`, `peerAck`, hold mailbox name | Yes | **Yes** | No. Lower values are dropped silently by the contact | Frozen; never used again without a handoff back |
| Native transport seeds per chat | Yes | No | Yes: a new seed is a new endpoint, which the capability record then describes | Frozen |
| Sessions, dial timers, attempt counts, pay quotes shown but not approved | No (in memory) | n/a | Made again | Gone |
| Outbox: message rows in `sending`, `queued`, `waiting`, `held`, with their wire ids and resend window; pending edits, reactions, pins | Yes | Ids make a resend harmless | No | Frozen |
| Message history | Yes | No | No | Frozen (whether it stays readable is [open question 5](#open-questions-for-the-owner)) |
| Items held for contacts in the hold storage | Stay in the storage; their records move | Sequence numbers, yes | No | n/a |
| Files in the FileBytes store (OPFS, Desktop files, database pieces) | Yes, whatever the size (a backup stops at 16 MiB; a handoff does not). The person may skip files over a size they choose; skipped files show as "on <device>" and can be fetched over the device link later | No | No | Frozen |
| File transfers in progress (`wire3`, confirmed bytes) | Yes | No | The transfer starts over | Frozen |
| Private groups: member seed, chain, epoch secrets, send counter, seen windows, hubs used | Yes | **Send counter and, for an admin, the chain head** | A member is caught up by `group-sync` within the 32 epochs kept; an admin's wrong commit cannot be undone | Frozen |
| Communities: chain and side branches, secrets, entry seed, rendezvous secret, counters, the last 256 frames | Yes | Counters; admin chain head | Frames, from hubs; the rest no | Frozen |
| Hub role | Follows the device kind: a phone's web app taking over from a Desktop stops listing itself as a hub; a hub the admin pinned by member key degrades until the profile is back on a device that can be one | n/a | n/a | n/a |
| Identity proofs and their keys, revocation records to republish | Yes | No (two publishers write the same content) | No | Frozen |
| DID key and what it lists | Yes | No | No (a new key is a new DID) | Frozen |
| Nostr | No private key is stored; the signed event and the cache move | No | Yes | Frozen |
| Settings: name, picture, theme, language, notifications, network, mutes, drafts, read and pin state | Yes | No | No | Frozen |
| Lock screen password | Yes (its verifier) | No | No | Kept: the standby screen is behind it |
| Shared local services and grants ([700](700-local-services.md)) | The records move. A service points at an address on one machine, so on another device it shows as "Not on this device" until the profile is back | No | No | Frozen |
| Hold and backup storage settings and credentials | Yes: an exception to "never inside a bundle" ([1000](1000-storage.md)), because the reader is the person's own device over an authenticated link and the new active device must keep holding items for contacts | No | By typing them again | Kept (needed to read a prepared handoff) |
| Push subscription and its VAPID keys | **Never.** Per browser. The new active device shares its own target on each contact's next live session, or `w: null` when it has none, which replaces what the contact held | n/a | Made new | The standby's worker stops showing "New message" and shows the notice in [Phone specifics](#phone-specifics) |
| Wallets | See [Wallets](#wallets) | | | |
| Profile registry entry (local name, color) | Name and color move as settings; the local profile id is each device's own | No | Yes | Kept |
| Local caches: public profiles read, link previews, last-seen balances | Optional | No | Yes | Frozen |

### The offline path: a prepared handoff

For "the desktop at home is off and I am out" (decision 1). On the active device, **Prepare handoff**:

1. quiesces as in step 2;
2. writes the same stream as one sealed object into the person's hold storage, under `<space>/handoff/<random>.ghostly-handoff` (a third folder beside `backups/` and `hold/`, [1000](1000-storage.md#storage-format));
3. writes `released` durably, then publishes the turn record at the same turn `N` with `active: null` and an **open release**: `[A, H, object, signature]` where the signed `to` is `null`.

Any enrolled device then shows "Ready to pick up" and, on **Use on this device**, fetches the object, verifies it against `H` from the record, publishes `N + 1` and starts.

- **Who can read it.** The object is sealed with a key derived from `D` and a random salt in its header (`HKDF(D, salt, "handoff-snapshot")`), so it takes `D` to open, and the storage credentials to fetch (enrollment gave both). The storage provider sees ciphertext and its size. With a lock password set, the key also takes the password (the bundle's own passphrase mode of [05](05-backups.md)), so a stolen empty standby cannot open it.
- **Authenticity.** `H` is in the release, signed by the releasing device's key and inside the sealed turn record. A provider cannot swap the object for another.
- **Staleness and rollback.** The release names the turn it gives up. An older snapshot left in the bucket belongs to an older turn and is refused: a device takes only the object the current record names.
- **Deletion.** The taking device deletes the object once it runs. The releasing device deletes it if it takes its own turn back. Objects in `handoff/` older than the current turn are deleted by any active device that finds them.
- **How long.** Until someone takes it. Nothing expires by a clock, but while nobody is active the profile is offline: texts wait in contacts' DHT mailboxes and holds as when the app is closed, held items wait up to their seven days, Ark and Bark coins are not renewed. The app says so.
- **Taking it back.** The device that prepared can press **Use here again**: it publishes `N + 1` from its own state, which is the snapshot's state.
- **Without hold storage.** Prepare handoff needs S3-compatible storage ([1002](1002-s3-storage.md)). Without it the only path is both devices online. A local file as the carrier (a USB stick) fits the same format and is a small addition.

### Two devices taking at once

The phone and the desktop could both press the button on one prepared handoff. Both would publish `N + 1`. To settle it without clocks: a device that published a turn waits and reads the record back from every relay it uses before it starts the engine (a few seconds). If it finds a different record at the same turn, the device whose key is lower bytewise keeps the turn and the other stands down. Whether DHT nodes accept a second, different packet at an equal sequence number varies by implementation and must be measured; if they refuse it, the first writer wins and the second learns from the refusal. Across relays that never see each other this cannot be made certain, which is why it is in the "detected" list.

### Forced takeover

For a device that is lost, broken or wiped while it was active. Only a standby with a frozen copy, or a copy restored from a backup, can do it (an empty standby has nothing to run). The person chooses **My other device is lost or broken**, reads what will be missing, and confirms. The device publishes `N + 1` with no release, applies the counter stride, and starts under these rules:

- every wallet follows its "forced takeover" rule in [Wallets](#wallets);
- unfinished payment attempts become `unknown` and are only reconciled, never run again (the restore rule of [05](05-backups.md#restore));
- a group admin signs no commit until it has caught up with the chain from at least one member, so it cannot fork the group from an old head;
- every other device shows that the turn was taken without a release.

### Counter stride

Old state means old outgoing counters, and a contact drops what is at or under its high-water mark. So a forced takeover (and a start from a backup) adds a fixed stride of 2^20 to every persisted outgoing counter before the engine starts: the mailbox `sequence`, the capability `rev`, the hold `pointerRev` and `outSeq`, and each group's send counter. Readers only require "greater", so a gap is accepted for the mailbox, the capability record and the hold pointer. To be checked: that the groups' seen windows and the hold manifest's "strictly increasing" rule accept such a gap. Incoming high-water marks need no change: something taken twice is removed by its message id.

### After a forced takeover

If the old device comes back, it is `superseded` and its state has forked from the active one. It offers **Send what is only here**, over the device link, to the active device:

- messages it received or sent that the active one lacks, by id (a union, no ordering promise beyond timestamps);
- files of those messages;
- money: its unspent Cashu proofs and unredeemed tokens as tokens, which the active device redeems at the mint (what was already spent fails harmlessly); for wallets with a phrase nothing needs sending, since the active device reads the same wallet.

Nothing else is merged: not counters, not group state, not settings. Then the old device's copy is replaced by a normal handoff the next time it takes the turn.

### Incremental handoff

Because state has one writer at a time, a later handoff needs only what changed since the two devices last agreed.

- Every write to the peer database and the profile's local keys is stamped with a **change number**, a counter of the profile that the active device increments. Deletions leave a small marker. This is new engine work: every store write goes through one place.
- Each device remembers, per other device, the **base**: the change number and the state digest at their last handoff, and a random **lineage** id that changes at every forced takeover or restore.
- `handoff-request` carries the lineage and base. If they match what the active device has, it sends only records, markers and files above the base; otherwise the full state.
- Databases owned by a wallet SDK (Ark, Bark, the Fedimint client file) are opaque and always move whole.
- After applying, both sides compare a digest over (store, key, change number) for everything. A mismatch falls back to a full handoff, never to a guess.

The first handoff to a device, a handoff to an empty standby, a lineage mismatch, a database version change and a failed digest are all full handoffs.

## Wallets

Decision 2 proposes that wallets move with the profile, under the turn. The rule that makes it safe is the same for every provider: **a wallet's secrets and its SDK database are used by the active device only; a frozen copy is never opened; the copy that arrives replaces the one that was there.** What differs is what a frozen copy is worth if the active device is lost, and what a double-active window costs.

| Provider | What moving means | Two copies by its own design? | Cost of a double-active window | Rule in a handoff | Rule in a forced takeover |
|---|---|---|---|---|---|
| **Cashu** | The proofs themselves (no seed: "Secrets are random, so there is no seed to restore from", `packages/browser/src/engine/wallet.ts`), pending melts with their reserved proofs and blank outputs, mint quotes, history | No. A proof is a bearer coin | Both spend the same proofs: the second spend fails at the mint, which can break a payment a contact was promised. Real loss: change or received ecash that exists only on the device that is later wiped | Proofs, melts and quotes move exactly once. The standby marks its proofs `moved` and never spends them | The frozen proofs are checked at the mint before they count; spent ones are dropped. Ecash the lost device received after its last release is gone unless that device comes back |
| **Fedimint** | The phrase and federation list (peer database) and the client database, one OPFS file per federation | No: "A federation is never joined fresh twice with one mnemonic" ([2xx Fedimint](2xx-fedimint.md)) | Two clients on one phrase collide on keys | The client file moves whole when both devices run the same client version; otherwise the new device joins with recovery from the guardians' backup. The standby never opens its file again | Never open the old file: join with recovery. Notes in flight follow the journal. Recovery of a real profile is listed as not yet exercised in that WISP, so this must be tested first |
| **Ark via Arkade** | The phrase and the wallet's own database (`ghostly-ark-<wallet id>`): "A recovery phrase alone is not this database backup" ([202](202-arkade.md)) | Not stated anywhere; assume no | Two copies sign from the same coins and disagree about renewals | The database moves whole and keeps its wallet id (a restore gives a new id because it is a copy; a handoff is a move) | The stale database is what a restored backup has today, with the same open risk ("stale-backup and device-loss scenarios" are an open gate in 202). Needs the provider's guidance |
| **Ark via Bark** | The phrase and two databases (`ghostly-bark-<id>` and its on-chain one), which a backup leaves out today | Not stated; assume no | As Arkade. A unilateral exit in progress "needs this device's wallet database, not only the phrase" ([204](204-bark.md)) | Both databases move whole. If they cannot be exported (unknown: today's backup skips them), the fallback is the server's recovery scan plus an on-chain scan, which a restore does not start today (`packages/browser/src/engine/paymentAdapters/bark.ts`) and would have to | Recovery scan from the phrase. An exit in progress on the lost device is lost with it. Not available in the CLI |
| **Spark and the Breez Lightning source** | The phrase and API key. The SDK database is named after the phrase and rebuilt from Spark's operators | **Explicitly no**: "Two SDK instances over one seed disagree about the leaves" and a swap left a leaf out ([2xx Spark](2xx-spark.md)) | Leaves out of sync, a payment that fails or a leaf missing for a while | The old device closes the SDK before the release; the new one opens from the phrase and syncs. The database does not move | The same. Unfinished sends are found by their idempotency key |
| **Lightning via NWC, Core Lightning, LND** | A credential (connection URI, rune, macaroon and certificate) and the local journal. The money is at the node | Yes, the node serves any holder of the credential | No funds at risk from two readers. Two journals diverge, and both could try to pay the same invoice (a node refuses a second payment of one hash) | Credential and journal move. An outgoing payment left `sending` becomes `unknown` and is only reconciled (`lightningService.ts`) | The same. The journal of the lost device is lost; the node's own history is the truth |
| **LND certificate pinning, Bitcoin Core** | Desktop only (Rust commands) | n/a | n/a | The record moves; on a device that cannot run it the card shows "Not on this device" and is kept intact | The same |
| **WebLN** | No secret; it is the browser's own provider | n/a | n/a | Nothing moves. The card shows only where a provider exists | The same |
| **Lightning addresses, another wallet** ([205](205-lnurl.md)) | Nothing is stored | n/a | n/a | Nothing | Nothing |
| **On-chain (BDK)** | The phrase, the public changeset and coin reservations. Testnet only today | Yes for reading: everything is rebuilt from the chain | Two devices can sign two spends of one coin; the chain takes one. A failed payment, no loss | All three move | Phrase plus a full scan; reservations of the lost device are gone, their reviews are cancelled |
| **USDT** | The seed and the journal, which holds the nonce guard and the exact signed bytes of unfinished sends | Reading yes. Sending no: a second device without the journal has no nonce guard | Two transactions at one nonce: one is dropped; an `unknown` send blocks the account until someone looks | Seed and journal move exactly | The seed alone: sends stay blocked for the account until its nonce on chain is checked against the last known one ("A consumed nonce with an unknown hash remains uncertain", [USDT integration](../USDT-INTEGRATION.md)) |

A wallet that the taking device cannot run (Bark in the CLI, a Desktop-only node) is **carried**, not dropped: its records and databases move as opaque parts, the card shows "Not on this device", and it works again when the profile is back on a device that can run it. While carried, nothing renews its coins, as with a closed app.

### Payments in flight

At quiesce the active device waits up to 30 seconds for what is already running, as wallet removal does (`packages/browser/src/engine/node.ts`), and shows what is still open using the same five kinds (`walletAwaiting.ts`: request, invoice, paid, unclaimed, sent). Then:

| In flight | What the handoff does |
|---|---|
| A review not yet approved | Cancelled on the old device; it releases its reserved coins first |
| A payment `submitted` or `unknown` | Moves as it is, becomes `unknown` on the new device and is only reconciled: nothing that moved may authorize a new send ([200](200-payments.md)) |
| A Cashu swap mid-way (inputs reserved, outputs saved) | Moves with its saved outputs; the new device recovers those exact outputs from the mint or proves the swap never happened, as the engine does after a crash |
| A Cashu melt awaiting the Lightning result | Moves with its reserved proofs and blank outputs; the new device polls it |
| Our Lightning invoice (a mint quote, a Lightning card's open invoice, a Fedimint receive) | Moves; the new device watches it. A payer who pays during the gap is not lost: the money waits at the mint, node or federation until the new device claims it |
| A held test-mint quote ([testnet faucet](200-payments.md)) | Moves as held: still never minted until the payer vouches, still deleted 60 seconds after it expires |
| A payment request of ours open in a chat | Moves with the chat. A request with a short-lived target (an Ark or Spark request of 15 minutes) may expire during the handoff and is then closed as expired |
| A contact's request to us, not paid yet | Moves with the chat; paying it is a new review on the new device |
| Ecash a contact sends during the gap | Ecash is never held ([4xx](4xx-store-and-forward.md)); it needs a live session, so the contact's app waits, as for a closed app |
| A file transfer in progress | Stops at its last checkpoint and resumes from the new device |

If something cannot be parked within the 30 seconds, the handoff says "A payment is still going through. Try again in a moment." and nothing changes.

## User experience

Copy follows the app's rules: short labels, one-line hints, details behind ⓘ. `<device>` is the device's name.

**Settings, Devices**

- Title: "Devices". Hint: "Use this profile on another device. One device is active at a time." ⓘ: "Only the active device sends, receives and pays, so your messages and money are never in two places. Move the profile whenever you like."
- Rows: name, kind icon, and one of "This device · Active", "Standby", "Standby · nothing stored", "Ready to pick up". Row menu: "Rename", "Remove".
- Buttons: "Add a device", "Prepare handoff".

**Adding a device**

- Active device: "Add a device". "On the other device, open Ghostly and choose Add this device to my profile. Then scan this code." QR code, "Copy code", "Valid for 10 minutes".
- New device, first screen: "I already use Ghostly", then "Add this device to my profile" or "Restore a backup".
- Both: "Do both devices show 482 913?" On the active device: "They match" and "They don't match". On the new one: "Confirm on <device>."
- New device: "Name this device" (prefilled: "Phone", "MacBook", "Firefox").
- Done, active device: "<device> added. It is on standby." Done, new device: the standby screen.
- With no lock password, once: "Anyone holding an added device can move this profile to it. Set a lock password to prevent that." with "Set a password" and "Not now".

**Standby** (the whole profile area, behind the lock screen when there is one)

- "Active on <device>". Hint: "Move this profile here to use it on this device." Button: "Use on this device". ⓘ as above.
- Prepared: "Ready to pick up". Hint: "Saved from <device> 2 hours ago." Button: "Use on this device".
- Link under the button: "My other device is lost or broken".
- The account switcher ([04](04-profiles.md)) shows such a profile with the word "Standby" in place of its unread count.

**Handoff progress** (on both devices)

- Title: "Moving your profile". Steps: "Connecting to <device>", "Getting ready", "Copying · 120 of 480 MB", "Checking", "Switching".
- "Cancel". Hint: "Nothing changes until the last step."
- Large files: "Bring files over 100 MB later" (a switch, off by default).
- Done, new device: the app, with a notice "This device is now active." Done, old device: the standby screen.

**Failures**

| When | Copy |
|---|---|
| The active device does not answer | "Can't reach <device>. Open Ghostly there, or pick up a prepared handoff." |
| Wrong lock password | "Wrong password." |
| The link dropped | "Stopped at 60%. It resumes when both devices are online." with "Resume" and "Cancel" |
| The copy failed its check | "The copy did not check out. Nothing changed." with "Try again" |
| No room | "Not enough space on this device: 1.2 GB needed." |
| Older app on the taking device | "Update Ghostly on this device first." |
| A payment is running | "A payment is still going through. Try again in a moment." |
| A wallet this device cannot run | "<wallet> does not work on this device. It stays safe and comes back on <device kind>." (a notice, not a failure) |
| The turn cannot be read | "Can't check which device is active. Check your connection." |
| Released, the other device never finished | "The move did not finish. Open Ghostly on <device>." with "Use here again" |

**Prepare handoff**

- "Prepare handoff". Hint: "Leaving? Save everything so another device can pick it up while this one is off." ⓘ: "Your profile is saved, encrypted, in your own storage, and this device stops. Until a device picks it up, messages wait as when Ghostly is closed."
- Button: "Save and stop". Without storage: "Set up storage first" (opens the storage settings).
- After: the standby screen with "Ready to pick up" and "Use here again".

**Forced takeover**

- "Take over without <device>?" Text: "This device has your profile as of <date>. Messages and money that reached <device> after that are not here. If <device> comes back, it stops and offers to send what is missing." ⓘ lists each wallet with one line ("Cashu: 12 000 sats here, checked with the mint when you take over").
- The person types the device's name to confirm. Button: "Take over".

**Superseded**

- "This device was replaced". Text: "<device> took over without this one. This device has stopped."
- "Send what is only here" (with counts: "3 messages, 1 payment"), and "It was not me", which leads to: "Take the profile back and remove <device>?"

**Restore where a device set exists**

- "This profile is active on <device>". Buttons: "Add this device instead", "Take over", "Cancel".

**Remove**

- "Remove <device>?" Text: "It can no longer take this profile." If it held a copy: "It still holds your chats and wallets as of <date>. If it is lost, move your money and pair again with your contacts." Buttons: "Remove", "Remove and move money".

**What contacts see.** Nothing that says "device". They see what an app that closed and opened again shows: the chat goes offline and comes back. They can infer a change of device from what already differs between clients: the transports and capabilities in the capability record (a phone's web app lists fewer than a Desktop), a new push target, another network address. Hiding that would mean every device pretending to be the least capable one, which is not proposed.

### Phone specifics

The phone is the installed web app ([docs/WEB.md](../WEB.md)).

- **Storage can be evicted.** Browsers may clear a site's storage under pressure, and Safari clears script-writable storage of sites not used for a while unless the app is on the Home Screen (to be verified against current WebKit behaviour). Nothing in the app asks for persistent storage today. A device MUST call `navigator.storage.persist()` and be granted before it can become active, and on iPhone and iPad it must be installed to the Home Screen first; otherwise: "Add Ghostly to your Home Screen to use this profile here." An active phone whose storage is evicted has lost the profile's only current copy: the frozen copy on another device and a forced takeover are the recovery. This is the main argument for the desktop keeping a frozen copy.
- **Background limits.** A phone suspends the web app in the background, so a handoff runs with the app in front (it asks for a screen wake lock and says "Keep Ghostly open"). The stream resumes after an interruption.
- **Quota.** The taking device checks `navigator.storage.estimate()` against the manifest before the stream starts.
- **Push.** The subscription is per device ([401](401-paired-chat.md#wake-up-push)). When the phone becomes active with "Wake me while closed" on, each contact gets its target at their next live session. When it goes to standby, contacts still holding its target may wake it until their next session with the new active device replaces it. Browsers expect a push to show something, so the standby's worker shows "New message. This profile is active on <device>." and a tap opens the standby screen. Whether a standby phone should keep being woken on purpose is [open question 6](#open-questions-for-the-owner).
- **Mobile data.** Before a full handoff on a metered connection: "This copies 480 MB." with "Continue" and "Later".

## Security and privacy

### Threats

| Threat | What limits it | What remains |
|---|---|---|
| A stolen standby with a frozen copy | The profile's lock screen. Removal closes the turn to it | Everything in the copy is readable by someone who can read the device's storage: seeds are sealed with a key stored beside them ([202](202-arkade.md), persistence). Removal does not change chat keys or wallet seeds; see [Removing a device](#removing-a-device) |
| A stolen empty standby | It holds no chat key and no money. A pull needs the lock password | Without a lock password it can pull the whole profile from an unattended active device. It can read the turn record and the hold storage's ciphertext |
| The hold storage is compromised | The snapshot is sealed under `D` (and the lock password when set); its digest is signed in the turn record | Size and timing of handoffs. Deleting the object denies a prepared handoff: the device that prepared it can still take its turn back |
| A relay hides the turn record or replays an old one | Several relays, the DHT itself on Desktop, the highest turn wins; an old packet cannot replace a newer one on an honest node | A device that only reaches lying relays is not told it was replaced. It then acts, which is the double-active window |
| Rollback to an old snapshot | The release names the turn and the digest; a device takes only the object the current record names | None found |
| An attacker with brief access to the unlocked active device adds their own device | The six digits must be confirmed on the active device; the invite lasts 10 minutes; adding a device asks for the lock password when one is set; every device shows the device list, and a new device raises a notice on the active one for a day | With the app unlocked and no lock password, an attacker at the keyboard can enroll a device, as they could export a backup today |
| A hostile enrolled device raises the turn | Shown on every device as taken without a release; "It was not me" takes it back and removes it | The honest device is stopped until the person reacts |
| A device's storage is cloned | Only the self-check on chat records | Two actives with one device key; not prevented |
| A contact tries to stop the person by claiming a higher turn | Hints only trigger a read of the record | None |

### What an observer of the DHT learns

- **The turn key** is derived from `D` and appears nowhere else: not in a chat, not next to the DID. An observer cannot link it to a profile except by the address that publishes it, which also publishes the chats' records ([04](04-profiles.md#security-and-privacy) says the same of two profiles).
- **The record** is sealed and padded to one size, so its content, the number of devices and their names are not visible.
- **The sequence number is in the clear.** Someone who watches that key over time sees it jump by 2^20 at every handoff: the count and the times of the switches since they started watching, not the absolute count (the start is random). Small changes show as `rev` steps. This is the price of the relay-enforced lock; the alternative (a clock there, the turn only inside) hides the count and lets a stale device overwrite a newer record.
- **A switch changes the publishing address** for the turn record and for every chat record at the same moment. A relay that sees both can tell a device change from a network change only by the capability set, as today.
- **The hold storage provider** sees an object appear and be fetched, and from which addresses.

To keep the footprint small the record is put hourly and on change, never per message, and read at the pace in [When a device checks](#when-a-device-checks).

### Before this ships

- A written review of this document by someone who did not write it, and a security review of the implementation of each phase before its release ([docs/SECURITY-REVIEW.md](../SECURITY-REVIEW.md)).
- The checks named "to be checked" above, measured and written into this document: the sequence number on both relay operators and the Rust client; equal-sequence behaviour; the counter stride against the groups' windows and the hold manifest; exporting the Bark databases; moving a Fedimint client file between a browser and another browser; a non-extractable device key per platform; WebKit's storage rules.
- For each wallet provider, a test that moves a funded Testnet wallet there and back, and one that forces a takeover from an old copy, with the balance conserved or the loss exactly as this document says.
- No Mainnet wallet moves until its provider's row has passed both.

## Compatibility and rollout

**Old peers.** Contacts are untouched: no frame, record or capability of a chat or a group changes. A handoff looks like an app that restarted.

**Old app versions on the person's own devices.** An app from before this WISP knows no device set. Given the profile by a backup, it ignores the fields and starts the profile as active: the unsafe restore of today. So a profile with a device set MUST refuse to restore in an app that cannot read it. A bundle's payload version is raised when it carries a device set, and readers already "reject a higher version" ([05](05-backups.md#envelope)). An old app enrolled as a device is impossible: enrollment is new.

**Record and wire changes, all additive.**

| Change | Who sees it |
|---|---|
| A new Pkarr record `_turn` under a new key, with a counter as its sequence number | The person's devices, relays and DHT nodes |
| A device link: an ordinary paired session with a new capability `handoff/1` and four frames | The person's devices only |
| A third folder `handoff/` and a media type in the storage layout ([1000](1000-storage.md)) | The person's storage |
| The backup payload: a device set, never a device key; a higher version when present ([05](05-backups.md)) | Backups |
| Local: the device state, the change numbers, the staging area | One device |
| Optional, later: a turn element in `pair-offer`, the capability record and the mailbox envelope | Contacts |

**Phases.**

| Phase | What it gives | Engine | UI | CLI | Tests |
|---|---|---|---|---|---|
| 1 (1.1) | Add a device; a full handoff with both online; wallets per decision 2; the standby screen; the restore guard; forced takeover with the counter stride; persistent storage on the web | Device key, `D`, the turn record and its checks, the device state gate in front of the engine, the device link, the handoff state machine, quiesce, the staging area, wallet rules per provider, `navigator.storage.persist` | Devices page, enrollment, standby, progress and failures, forced takeover, superseded, restore guard | `ghostly device list`, `add`, `join <code>`, `use`, `status`, `rename`, `takeover`, between CLI profiles only (the CLI's backup payload is not the app's, [11xx](11xx-headless.md)) | Unit: record codec, refusals, size and padding; the state machine with a crash at every step; the release; the stride. Engine: two engines and a contact over a fake relay and DHT. End to end: two browser contexts as two devices plus a contact; Desktop to web. Per wallet: move there and back on Testnet |
| 2 | Prepare handoff through the hold storage; removing a device with a new `D` and the tombstone; "Send what is only here"; "Move money to new wallets" | Snapshot object, open release, the take race, removal, the recovery union | Prepare handoff, pick up, remove, superseded recovery | `device prepare`, `device remove` | The above against a local S3 server; two takers of one snapshot; a removed device coming back; a tampered and a swapped object |
| 3 | Incremental handoff; files brought later over the device link | Change numbers on every store write, markers, base and lineage, digests | Faster progress, "on <device>" files | Same commands | Property tests: any sequence of writes then an incremental handoff equals a full one. A **soak**: two devices switch back and forth a few hundred times while a contact and a group send messages, files and Testnet payments; at the end no message is lost or doubled, balances add up, every counter a contact saw only grew, and the relay log shows one writer per record at a time |
| 4 (optional) | Contacts refuse a superseded device; participation-key rotation | A turn element in three formats; [02](02-peer-keys.md)'s rotation | A notice when a contact's app refused an old device | None | Interop with apps from before |

Each phase is useful alone, and phase 1 already replaces the unsafe restore for the case the owner described.

## Why not two live devices

It is the natural next wish, so the reasons are written down. Two live devices need: a device key per chat known to each contact, so the contact can send to both and tell them apart (every chat record and the session handshake change, and old contacts cannot follow); delivery of each message to every device, with no server to fan it out (the sender's app does it, or the devices sync between themselves all the time); group counters and admin commits per device; and wallets with two writers, which Cashu proofs, Fedimint clients and Spark leaves do not allow. One active device with a handoff needs none of that and keeps every existing format.

## Open questions for the owner

1. **Handoff while the active device is off (Prepare handoff).** Recommendation: yes, in phase 2, through the hold storage. Cost: it needs S3-compatible storage set up; the storage credentials reach every enrolled device; and it adds the one race this design cannot close with certainty (two takers on relays that do not see each other). The alternative, both devices online only, is phase 1 and is enough to start.
2. **Do wallets move?** Recommendation: yes, under the turn, but per provider and only after that provider's tests pass, Testnet first. Cashu, remote Lightning, on-chain and USDT are well understood. Fedimint, Ark, Bark and Spark each have a point marked "to be checked" and would stay on their device (carried and shown as "Not on this device") until it is. Cost of "wallets stay": the phone has no money when away from home, which is half of the request. Cost of "wallets move": the largest test and review effort in this document.
3. **When.** Recommendation: phase 1 in 1.1, after 1.0.2, as proposed.
4. **Does a standby keep a frozen copy?** Recommendation: a choice per device at enrollment, default "keep" on a desktop and "keep nothing" on a phone. Keeping a copy makes later handoffs fast and is the only recovery if the active device dies. Keeping nothing makes a lost phone harmless and every move to it a full copy.
5. **Can a standby with a copy show its history, read-only?** Recommendation: not in phase 1 (a locked screen only). It is useful, but every screen that reads history would need proof that it starts nothing on the network.
6. **Should a standby phone still be woken by push** while the desktop is active but closed, so the person learns there is a message and can switch? Recommendation: yes, later: it fits "I am out with my phone". It means the active desktop keeps the phone's target with contacts instead of clearing it.
7. **Should every profile have a turn record, even with one device?** Recommendation: yes, from phase 2. It costs one more key and one hourly put per profile, and it lets a restored backup always find out that the original still runs, which closes today's "two live copies" for everyone.
8. **Should contacts refuse a superseded device (phase 4)?** Recommendation: not now. It tells contacts when the person switches and changes three formats, and it does not protect money.
9. **A lock password before a profile can have a second device?** Recommendation: strongly suggested, not forced. Forcing it makes the stolen-standby case safe by default and adds a step to a flow that should take a minute.
10. **CLI profiles as devices of a person's profile** (a bot that "is" the person). Recommendation: no. The CLI's stored profile differs from the app's and Bark is missing there; a bot should be its own profile and a contact. CLI to CLI handoff (moving a bot to another server) is in phase 1.
11. **How many devices?** Recommendation: 4, the number that fits the record with names.
12. **A local file as the carrier of a prepared handoff** (no cloud storage at all). Recommendation: yes, small, in phase 2.
13. **Participation-key rotation** ([02](02-peer-keys.md)) as its own WISP, since it is the real answer to a lost device that held a copy. Recommendation: design it alongside phase 2.

## Conformance (candidate)

A client that implements this WISP MUST: keep a device key that never leaves the device and is in no backup or handoff; start nothing on the network for a profile whose device state is not `single` or `active`; write `standby` durably before it signs a release; raise the turn only on a person's action; start as active only with a verified state and a stored release, or after an explicit forced takeover; use the turn and `rev`, never a clock, as the turn record's sequence number; stop at once on a higher turn it did not release; never open a wallet database it holds as a frozen copy; mark moved payment attempts `unknown` and never run them again; apply the counter stride on a forced takeover and on a start from a backup; and never send a handoff frame on anything but a device link.

## References

[Profiles](04-profiles.md), [backups](05-backups.md), [peer keys](02-peer-keys.md), [store-and-forward](4xx-store-and-forward.md), [storage](1000-storage.md), [payments](200-payments.md), [wallets](../WALLETS.md), [DHT delivery](../DHT-DELIVERY.md), [the web app](../WEB.md). [BEP 44](https://www.bittorrent.org/beps/bep_0044.html) for the sequence number rule; [Pkarr](https://pkarr.org).

## Revision log

One file per change in [changes/06-devices/](changes/06-devices/) ([how](00-process.md#revisions)). The site lists them here, newest first, and derives the Revision and Updated rows from them.
