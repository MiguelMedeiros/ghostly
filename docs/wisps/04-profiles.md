# WISP 04: Local Profiles

| Field | Value |
|---|---|
| Candidate number | 04; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [01](01-ghost-core.md), [02](02-peer-keys.md), [200](200-payments.md), [700](700-local-services.md) |
| Implementation | Experimental: web, desktop and browser extension clients; the headless CLI keeps a profile per folder ([1100](1100-headless.md)) |
| Summary | Keep separate lives on one device (chats, wallets, services and settings), never announced to contacts. |
| Availability | Available |
| Notes | Web, desktop and extension; the CLI has profiles of its own. Switch from the account bar in one tap. |
| Feature | [Your space](https://ghostly.tools/#space) |

> This is a review draft. Candidate numbers are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md) and [implementation evidence](IMPLEMENTATION.md).

## Scope

A **profile** is a local container on one device. It holds everything a person may want to keep apart (for example "Personal" and "Work"), and exactly one profile is active in a running client. A profile is not a protocol identity: contacts never learn that profiles exist, how many there are, or their names. Each chat already has its own keys ([02](02-peer-keys.md)); a profile groups chats and everything tied to them.

Number note: legacy reader paths once used `04` for capability negotiation (now [03](03-capabilities.md)). Per the [numbering map](NUMBERING.md), the current number takes precedence; the old `04-capabilities` alias still resolves.

## What belongs to a profile

| Linked to the profile | Where it lives |
|---|---|
| Chats and their keys, messages, files, drafts, read and pin state | Profile storage namespace and peer database |
| Wallets: Cashu proofs, wallet seeds and configuration, payment-intent journal ([200](200-payments.md)) | Peer database |
| Ways of paying chosen per chat | That chat's record, inside the profile |
| Shared local web apps and per-contact grants ([700](700-local-services.md)) | Peer database |
| Wallet backups and restores | A backup is made from, and restored into, the active profile |
| Settings: color theme, light/dark mode, language, nickname, notifications, lock screen, network | Profile settings record |
| Wallets per network: Mainnet and Testnet wallets side by side, each one created on its own ([200](200-payments.md)) | Peer database |
| Profile picture, shown to paired contacts with the nickname ([401](401-paired-chat.md)), and whether contacts are told either (on unless switched off); the names and pictures contacts sent, with their chats | Peer database |
| Optional identity proofs (300 series) | Peer database |

Nothing crosses profiles. A contact of one profile cannot reach an app, a wallet or a chat of another.

## Local model

The device keeps one registry, the only record shared by all profiles:

```json
{ "version": 1, "active": "<id>", "profiles": [{ "id": "", "name": "Personal", "createdAt": 0 }] }
```

- `id` is empty for the **default profile** or ten characters `[a-z0-9]`. The default profile keeps the storage names clients used before profiles existed, so upgrading moves no data.
- `name` is 1 to 32 characters after collapsing whitespace. It is a local label, distinct from the nickname shown to contacts.
- The default profile starts with the built-in name `"Personal"`, which the client shows in the app's language until the user renames it. A backup of it carries `"Personal"` as written, never the translated name, and marks it as the built-in name ([05](05-backups.md) § Payload, `profile.builtIn`), so the profile restored from it follows the language too. A restored name the backup does not mark as built-in is kept as written: a profile someone named `Pessoal` stays `Pessoal` in every language. A backup with no marker (clients wrote none before) is read by its own language: its name is the built-in one only when it is `"Personal"` or the default profile's name in the language of the backup's settings (`Pessoal` in a backup made in Portuguese, as clients wrote it then).
- `restored: true` marks a profile brought back from a backup ([05](05-backups.md)). The client shows its name with the word for "restored" in the app's language; the registry keeps only the name, and a backup of it carries only the name. A client lets the user edit the name alone, never the word, and renaming keeps the mark; the user takes it off on purpose. A name ending in the word in parentheses in any language the client speaks (` (restored)`, as clients wrote it before the mark, ` (restaurado)`, `（復元）`) is read, renamed and restored as the name without it, marked.
- A missing or corrupt registry is read as a single default profile. An unknown `active` falls back to the default profile.

Each profile `p` maps to separate namespaces: storage prefix `ghostly_` (default) or `ghostly_<p>_`; peer database `ghostly` or `ghostly_<p>`; single-peer lock `ghostly-peer` or `ghostly-peer-<p>`; settings record `ghostly_app_settings` or `ghostly_<p>_app_settings`. Because the default prefix is also the start of every other profile's keys, a client MUST NOT treat a key of the form `ghostly_<10 characters>_…` as the default profile's.

## Creating, editing and switching

- **Create** asks only for a name. The new profile starts empty, inherits the current language, light/dark mode and lock screen (password included), and receives a color theme that no existing profile uses (cyan, purple, classic, monochrome, then cycling), so the switch is visible at once.
- **A name for contacts.** A new profile asks once "What should people call you?": the first start of the client (no settings saved, no chat) and a profile made with Create. The field starts empty; Skip keeps the anonymous label contacts see. A profile restored from a backup ([05](05-backups.md)) or added to a profile on another device ([06](06-devices.md)) is not new and is not asked: the question is a local key of its own (`name_step`), which backups and handoffs leave out. Clients do not ask under test automation unless a test asks for it.
- **Edit**: name and color can be changed at any time from the profile page; the color is part of the profile's settings.
- **Switch** persists `active` and restarts the client. No peer connection, wallet, timer or cached state of the previous profile may keep running beside the new one. Contacts of the previous profile see it go offline, as when the app closes. `active` is what the next start opens; a running client stays the profile it started as. A web tab that waited for another tab to close takes over as the profile it opened with, even when the other tab chose another one meanwhile, and names, lock checks, wake-up push and switching all follow the profile it runs.
- **The account switcher** (web and desktop) lists the saved profiles from the account bar's Profile place (a chevron, a right-click, a long press, or Alt+Shift+P) and, on a phone, from Settings (its row, or holding the Settings tab). One tap switches. Each profile reopens on the page it was left on (never an address carrying keys). While the client restarts, the target's picture and name cover the page. A locked profile shows its lock screen, naming it, before anything of it renders. For profiles that are not running, the switcher reads only local data: the picture from the profile's peer database, and the messages left unread in its chats (groups are not counted). Nothing new reaches a profile that is not running, so this count is what was there when it was left. What is waiting for it since then is shown apart, as "New" (see [Checking other profiles](#checking-other-profiles)). A locked profile shows neither its picture nor its counts, only that it is locked.
- **Remove** deletes a profile for good: its local keys, its peer database, and its wallets' own storage that no other profile references (each Ark wallet's database, each Bark wallet's two, each Fedimint federation's client file); then its registry entry. The first profile and the active one cannot be removed, nor one that another window is running (its peer lock `ghostly-peer-<ns>` is held). The client shows what the profile holds (chats, sats, wallets, apps), offers a backup ([05](05-backups.md)) first, and asks for the profile's name to confirm.
- A client MAY run a process in its own storage space (desktop `GHOSTLY_PROFILE`, for testing): its registry and namespaces are prefixed with that space, and the default profile of the unprefixed space never treats another space's keys as its own.

## Checking other profiles

Only the running profile is online. What a contact sends to another profile of the device waits with the contact: a short text in the contact's DHT mailbox ([403](403-dht-text.md)), items held under a hold/1 pointer ([404](404-store-and-forward.md)). A client MAY look there now and then, from the running profile, so the person knows something waits without switching. When it does:

- **What it reads.** For each other profile, its paired chats as that profile stored them (never entry sessions), and for each chat the one mailbox the chat would read first (the pinned one once the contact uses it, the invite's before) and, when that profile accepts held items, the contact's hold pointer. For each community group it is in, the group's beacon, whose head names the newest frame a hub holds ([903 · Group Community § Head](903-group-community.md#head)). Nothing else: no capability record, no presence, no manifest, no bundle, no frame.
- **Mesh groups** are not covered: nothing on the network says a member has frames waiting ([902 · Group Mesh](902-group-mesh.md#security-and-privacy)).
- **What it keeps.** A DHT envelope's sequence, text and receipt share one sealed record, and the contact republishes a keep-alive envelope every few minutes, so only opening it tells a text from a keep-alive. The envelope is opened and its signature checked exactly as the chat would (a copy of the invite can write to the invite's mailbox; an unchecked "new" could be forged). What is kept is whether it carries a text that chat has not taken yet, and the text's id; the words are dropped unread. A hold pointer gives the number of items held beyond what the profile took. A community group's head is the identity of a frame (sender, epoch, sequence, time); it is new when that profile's stored state has not taken it. A rejected alternative read the record's TTL, which differs between a text and a keep-alive envelope, without opening it: it is not part of [403](403-dht-text.md), and it cannot tell a text already taken from a new one.
- **What it never does.** It publishes nothing, writes nothing in the other profile's storage (its database is opened read-only, without a version, and closed at once; its local storage is only read), fetches no held bundle and opens no link. The other profile's state does not move: when it runs, its own chats fetch as usual. What was seen is kept in the running client, beside the registry (`<registry>-peek`), until that profile runs; a text stays marked after its envelope expires. The profile clears it when it starts.
- **Which profiles.** Not a locked one (it shows nothing, as before), not one another window runs (it is online itself), and not one that reads the network another way than the running one: another set of relays, or relays where the running one reads the DHT (desktop "Also use Pkarr relays"). Reading such a profile's records over the running profile's path would show that path something the other profile never sends there.
- **Pace and budget.** About every three minutes with ±15% jitter (a DHT text stays in its mailbox five minutes, and an unconfirmed one is sent again for about an hour), four times slower while the client is hidden and twice slower on battery where the platform says so. Each profile has its own budget: at most 6 reads a round and 18 in any ten minutes, chats taken in turn. Reads are background requests; the relays' request budget is a wait, which ends the round.
- **Signals.** The account switcher shows "New" beside a profile with something waiting, apart from its unread count; the running profile's picture gets a dot besides the ring. A system notice "New message in <profile>" is off by default, needs system notifications on, is not shown when every such chat is muted in that profile, and follows the system's Do Not Disturb. Clicking either switches to that profile.
- **Setting.** "Check other profiles" is on by default in the desktop client and off in the web client and the extension. Desktop reads the DHT itself, so its reads spread over DHT nodes, and its request budget is not the relays'. The web and the extension read through two relay operators, which would see both profiles' reads from one address at the same moment, and share a 30-request-a-minute budget per relay with every chat. Turned off, nothing is read.
- **Privacy.** With the same read path, the network learns nothing it could not learn anyway: the records read are the ones that profile reads when it runs, from the same device and address, over the same relays or DHT. What changes is timing: the reads happen while another profile runs, so an observer of the path can link the two profiles' reads by time as well as by address (see Security and privacy). A client that must avoid that correlation leaves the setting off.

## Encrypted profile (proposal)

Planned, not built: a design for the owner's review. Nothing below is implemented, and the rest of this document describes clients as they are. An encrypted profile is opt-in, per profile: Settings → Privacy & security → "Encrypt this profile". A profile that does not turn it on stays exactly as it is today.

### What it protects, and what it does not

| Threat | Today | Encrypted profile |
|---|---|---|
| The profile's storage read while the client is not running: a copied browser profile or CLI folder, a disk image, a stolen device that is off or whose client is closed, a standby's frozen copy ([06](06-devices.md)) | Everything is readable: chat seeds, keys and invite codes, group secrets, Cashu proofs, wallet seeds (sealed with a key stored beside them, [202](202-arkade.md) § Persistence), backup storage credentials | Phase 1 secrets are ciphertext under a key only the passphrase opens. The reader has to guess the passphrase offline, at the cost of the KDF per guess |
| The same, for content | Messages, files, drafts readable | Phase 1: still readable. Phase 2 encrypts them |
| A running, unlocked client: someone at the device, malware in the same account, a debugger, the browser's own extensions with access to the origin | Everything | Everything: the data key is in memory and the engine uses it. Not a goal |
| Memory: a swap file, a hibernation image, a crash dump taken while unlocked | Everything | May hold the data key and unsealed seeds. Not a goal; the device's own disk encryption covers it |
| The lock screen | A screen gate over a running engine (S6); its PBKDF2 verifier sits in the clear | Unchanged and separate. Encryption is the start gate; the lock screen is still the gate over a running app |
| An OS keychain | Not used ([06](06-devices.md)) | Not used either: the passphrase is the only way in. A keychain would let the OS unlock without the person, which is the opposite of the goal; a later "remember on this device" through it is an open decision |
| Old copies of a secret: storage written before encryption was turned on (IndexedDB and LevelDB logs, SQLite free pages, the CLI journal, SSD blocks) | Not applicable | Turning it on rewrites every record, but a database engine or a disk may keep the old bytes until they are reused. Clients compact what they control (the CLI writes a fresh snapshot and empties its journal, `VACUUM` on `rows.db`); browser storage can't be forced. The client says so: a secret that was on the device before stays as safe as it was then; to be sure, move the money to a new wallet and pair the chats again |
| Push notifications | A keyless "New message" ([401](401-paired-chat.md)) | Unchanged: the push worker holds no key and shows the same words |
| A wrong guess at the prompt | Not applicable | The lock screen's backoff applies to the prompt; it slows a person at the device, not someone with a copy of the storage |

### Keys

```
passphrase ──PBKDF2-SHA256 (600,000, 16-byte salt)──▶ KEK (AES-256-GCM, never stored)
KEK ──AES-256-GCM, header as associated data──▶ wrapped DK (stored)
DK: 256 random bits, one per profile ──AES-256-GCM, field binding as associated data──▶ each sealed field
```

- **Passphrase:** at least 12 characters, as for backups ([05](05-backups.md)). It is not the lock password (4, or 8 with a device set); a client MAY use one prompt for both at start (see open decisions).
- **KDF:** PBKDF2-SHA256 with 600,000 iterations, the same as backups and the lock screen: one KDF in the code, WebCrypto on every client (web, Desktop's webview, extension, Node), no new dependency. Argon2id would resist GPU guessing better, but the only build in the app today is inside the OPAQUE WebAssembly module of [06](06-devices.md) and is not exposed; a standalone one is a new dependency to vet. The header names the KDF and its parameters, so a later version can add Argon2id or raise the iterations by rewrapping, without touching the data.
- **Data key (DK):** generated with `crypto.getRandomValues` (Node: `crypto.webcrypto`) when encryption is turned on. Wrapped once; the passphrase never encrypts data directly, so changing it rewraps 32 bytes and rewrites nothing else.
- **Wrapped key record**, the `envelope.ts` shape with its own format name, kept beside the profile's settings (web, Desktop, extension: the local key `ghostly_<p>_profile_key`; CLI: `<profile>/profile-key.json`, 0600):

```json
{ "format": "ghostly-profile-key", "version": 1,
  "kdf": { "name": "PBKDF2-SHA256", "iterations": 600000, "salt": "<b64url 16 bytes>" },
  "cipher": { "name": "AES-256-GCM", "iv": "<b64url 12 bytes>" },
  "profile": "<profile id, empty for the default>",
  "ciphertext": "<b64url: DK, 32 bytes, + tag>" }
```

  The associated data is the header fields joined by newlines, as in a backup, `profile` included, so a record copied to another profile's slot fails to open there. A reader refuses an unknown `format`, `version`, KDF or cipher, and iterations under 600,000 or over 10,000,000, as backups do.
- **Sealed field, version 2:** `{ "v": 2, "iv": "<b64url 12 bytes>", "ct": "<b64url>" }`, AES-256-GCM directly under DK with a fresh random 96-bit IV, no KDF per field. The associated data is `ghostly-field/2`, the database (or `local`), the store, the record's key and the field's name, newline-joined: a ciphertext moved to another record, store or field fails to open instead of being read as that one. One DK stays far below the 2^32 random-IV bound in phase 1 (secrets are written a few thousand times in a profile's life). Phase 2 (messages, file chunks) derives a subkey per store with HKDF-SHA256 (`info = "ghostly-store/1" || store`) so no single key reaches the bound.
- **Version 1 sealed seeds today** (`{version:1,salt,iv,ciphertext}` with a `deviceKey` beside it) are read as they are until the profile is migrated; then the `deviceKey` is gone. A seed sealed with a wallet password the person chose keeps that password; the record around it is sealed under DK like the others.

### What is encrypted

Phase 1, secrets (every item that lets someone act as the person or spend):

| Item | Where today |
|---|---|
| Chat seeds, keys, pinned contact keys, invite codes, native transport seeds | `StoredLink` in the peer database |
| Group and community secrets: member seed, epoch secrets, entry seed, rendezvous secret, admin chain keys | Peer database |
| Cashu proofs and swap secrets | Peer database |
| Seeds and credentials now sealed with a device key: every wallet's seed (Ark, Bark, Spark, Fedimint, USDT) and the provider wallets' secrets and API keys (on-chain among them, `providers/sources.ts`), the DID key, contact link seeds, identity proof keys, x401 keys | Peer database, beside their `deviceKey` |
| Backup and hold storage credentials (S3 keys) | The UI's settings in local storage |
| Invite codes the page keeps | The UI's local storage mirror |

The page does not get the DK. What it keeps in local storage that is secret moves behind the engine: invite codes are read from the engine's chats (the mirror keeps none on an encrypted profile), and storage credentials move into the engine's settings record, sealed there.

Phase 2, content: the messages store and the page's local storage mirror of recent messages, file bytes (OPFS, `fileChunks`, Desktop and CLI files), drafts, names and pictures. It needs the page's ~160 local storage uses and ~40 database opens routed through one layer first, and is a design of its own.

Wallet SDK databases (each Ark wallet's, Bark's two, Breez's, each Fedimint federation's client file) are not Ghostly's format. Their seeds are already ours to seal; what each database keeps besides (keys derived from the seed, contracts, a federation client's own secrets) is listed per SDK in its build slice, and each is either wrapped in our layer, left as it is with the reason written in its WISP, or opened only after unlock. Until then the client says which wallets keep data of their own outside the encryption.

Never encrypted: the profile registry (names and order, read before any unlock to show the switcher), the wrapped key record, the settings the start screen needs (language, theme, whether the profile is encrypted), and the push subscription.

### Unlock and lock

- **Start.** A client that finds a wrapped key record asks for the passphrase before the engine starts: web and Desktop show it in place of the lock screen; the extension's background waits, offline, until a popup or page unlocks it; the CLI asks before the daemon or a one-shot opens the store. Until the DK opens, the engine makes no connection, no ring, no poll, no DHT read, starts no wallet and reads no sealed field. The DK is unwrapped into a non-extractable `CryptoKey` (`unwrapKey`) held in one slot the engine owns.
- **Wrong passphrase.** The GCM tag fails on the wrapped DK: one error, "Wrong passphrase", with the lock screen's backoff. Nothing else is read or started.
- **Reload and profile switch.** A page reload or switch asks again: the DK is never written to `sessionStorage` or handed over the way the lock is (`lockHandover.ts`). The extension's offscreen document keeps the DK while it lives, so its pages do not ask again.
- **"Lock and stop Ghostly"** stops the peer (as a profile switch does: contacts see it go offline), drops the slot and the unsealed seeds cached in memory (DID, identity proofs, contact links, live wallet SDKs), and shows the passphrase prompt. The lock screen alone ("Lock") keeps working as today, over a running engine.
- **Checking other profiles** reads only what is not sealed; an encrypted profile that is not running is treated as a locked one and is not checked.
- **Device sets ([06](06-devices.md)).** A standby's frozen copy stays encrypted under DK, so a stolen standby needs the passphrase. The handoff stream carries the state decrypted inside its own encryption; the taking device seals it under its own DK. Whether every device of a set must be encrypted is an open decision.

### Turning it on, changing it, turning it off

- **On.** The person types a new passphrase twice. When a wallet holds money, the client first offers a backup (`backupReminder.ts`). Then, with the engine stopped (no writer but the migration): a `migrating` mark is written with the wrapped key record, each store is walked and each phase 1 field sealed in place, each version 1 seed resealed as version 2 and its `deviceKey` deleted, then the CLI compacts its journal and the mark is cleared. Each step is idempotent: a field already version 2 is skipped. Interrupted (crash, closed tab), the next start sees the mark, asks the passphrase and finishes. Until the mark is cleared, the reader accepts plain, version 1 and version 2 values.
- **Change passphrase.** Old passphrase, new one twice: the DK is unwrapped as raw bytes from the old record's ciphertext, wrapped under the new KEK, and the record replaced in one write. No data is rewritten; a non-extractable DK is not needed for it.
- **Off.** After the passphrase, the same walk the other way, under a `decrypting` mark, then the record is removed. Seeds go back to version 1 under a fresh device key, as clients write them today.
- **Forgotten passphrase.** There is no recovery: no reset, no hint, no copy of the DK anywhere. The profile's sealed data is lost; what remains is a backup made with its own passphrase, a device of the set that has the profile, or Remove. The client says so in the step that turns it on, and asks the person to confirm that they understood.

### Backups

A backup of an encrypted profile carries the data decrypted, inside the bundle's own encryption under the backup passphrase ([05](05-backups.md)), not the DK or the wrapped key record: a bundle restores with its passphrase alone, on any device, and a backup is no weaker than today. Restoring it makes a profile that is not encrypted; the client offers to turn encryption on right after. A light backup follows the same rule. A CLI backup made with `--no-passphrase` would put the secrets in the clear on disk: on an encrypted profile it is refused (see open decisions). The alternative, a bundle with the ciphertext and the wrapped DK, would need both passphrases to restore and couples the backup format to this one; it is not proposed.

### Headless clients ([1100](1100-headless.md))

The CLI uses the same engine, so the same fields are sealed in its store; its journal and snapshot hold ciphertext once the migration compacts them.

- `ghostly profile encrypt|decrypt|passphrase [--passphrase-file f]` turns it on, off, or rewraps.
- The daemon and a one-shot with no daemon read the passphrase from `--passphrase-file <path>` (a path, or `/dev/fd/<n>` for a descriptor), else `GHOSTLY_PROFILE_PASSPHRASE`, else a prompt when stdin is a TTY, else exit with a usage error before the engine starts. Never from the command line, as for backup passphrases. A command that goes through a running daemon needs nothing.
- A profile without the record works as today.

### Slice manifest

Each slice is one PR of about 400 changed lines, tests included, in order; each leaves the app working with the setting off.

| # | Slice | Contents | Tests |
|---|---|---|---|
| 1 | Profile key | `packages/browser/src/shared/profileKey.ts`: wrap, unwrap, rewrap, seal and open version 2 fields with the binding; refuses unknown headers | Wrap/unwrap, wrong passphrase, header changed, binding swap rejected (other record, store, field, profile), iterations bounds, rewrap keeps DK |
| 2 | Engine slot and sealed reader | One engine-owned DK slot; `sealSecret`/`openSecret` that write version 1 with a device key when no DK is set (today's behaviour) and version 2 when one is; every `newDeviceKey` caller moved to it; cached seeds dropped with the slot | Existing wallet, DID, link and identity suites unchanged; both versions read; drop clears the caches |
| 3 | Phase 1 fields | Per-store field map (links, groups, communities, Cashu proofs and swaps) sealed in the database layer on write, opened on read | Round trip per store; with a DK set, a raw database read shows no seed, invite code or proof secret |
| 4 | Migration | On, off, rewrap with the `migrating`/`decrypting` marks; idempotent steps | Interrupted at each step and resumed; plain, v1 and v2 read during it; off restores today's layout |
| 5 | Start gate | `start()` waits for the unlock on web, Desktop and the extension background; no transport, wallet or DHT before it | Engine test with a counting network: zero requests before unlock; wrong passphrase reads nothing |
| 6 | Page and settings | Passphrase prompt, Settings toggle and its warnings (no recovery, old copies, backup first), "Lock and stop", strings in all eight languages, changelog | UI tests of the prompt, backoff, toggle and messages |
| 7 | Page secrets | Invite codes out of the local storage mirror on an encrypted profile; storage credentials into the engine's sealed settings | Local storage scan finds no invite code or S3 secret |
| 8 | Backups | A bundle of an encrypted profile decrypted inside its envelope; restore offers to encrypt; backup offered before turning on with money | Backup on, restore elsewhere with the backup passphrase alone |
| 9 | CLI | `profile encrypt`, `decrypt` and `passphrase`, the daemon and one-shot unlock, journal and `rows.db` compaction | Folder scan after migration finds no known secret; daemon refuses to start without a passphrase |
| 10 | Wallet SDK databases | What each SDK keeps, and per SDK the decision above | Per SDK |
| 11 | End to end and docs | e2e: turn on, reload, nothing connects before the passphrase, the right one restores chats and wallets, "Lock and stop" leaves the peer stopped, backup restores on another device; WISPs 05, 06, 202 and 1100 updated; S18 in the security review | The e2e above; the existing suites with the setting off |

Phase 2 (content) is designed after slice 11.

### Open decisions for the owner

1. KDF: PBKDF2-SHA256 600,000 (proposed: one KDF, no dependency) or Argon2id through a vetted WebAssembly build.
2. One prompt at start for both gates (the passphrase unlocks and passes the lock screen), or two.
3. Backups: decrypted inside the bundle (proposed) or ciphertext plus the wrapped DK; and whether `--no-passphrase` is refused on an encrypted profile (proposed) or allowed with a warning.
4. Device sets: every device of a set encrypted, or a choice per device.
5. A "remember on this device" through an OS keychain, later, or never.

## Security and privacy

- Profiles separate data, not network presence. Two profiles on one device share its network address and timing; an observer may correlate them. Use separate devices when that matters.
- Checking other profiles reads another profile's records while this one runs. With the same read path it adds no new link to the network beyond the shared address, only timing; it is off by default where reads go through relay operators.
- The lock screen is a setting of each profile and applies when that profile starts; a new profile inherits it, so creating one is not a way around the lock. While locked, it shows nothing of the profile but a call that rings: who calls and what kind of call, with Decline and Answer, and Answer takes the lock password first ([601](601-webrtc-media.md), Locked). Reading another profile's data from the active one (a backup of it) or removing it requires that profile's lock password when it has a lock.
- "Clear all data" removes the active profile's data only, never the registry or another profile, and all of it but its wallets: its local keys (chats, drafts, settings, lock screen, backup storage), its files, and in its peer database the chats, messages, groups and shared services, the installed mini-apps with their data ([1200](1200-marketplace.md)), its identity proofs and their keys, its DID and its key, its own Nostr data and the public profiles it read, and from the settings record everything that is not a wallet's (nickname, picture, network settings, the storage for held items, the push subscription). The wallets stay (their records, proofs, payments, quotes, history and journal, and their own databases and files): ecash is money and nothing else holds a copy of it; the confirmation lists what goes (installed apps and their data only where Apps shows) and says the wallets stay. Before deleting, the peer takes back what it can, best effort and for a few seconds at most, never holding up the local wipe: it deletes the items it holds for contacts and their manifests from storage, publishes a `deactivated` record for a DID it ever published ([310](310-did-dht.md)), and publishes once more the revocation record of every identity proof it ever shared ([300](300-peer-proofs.md)); then it stops, so nothing it holds in memory is written back. The page ends the push subscription at the push service. Proofs posted on other sites (a Bluesky record, a Pubky file, a DNS record) and backups already saved stay where they are. Removing a profile deletes its wallets with it; the client says so and offers a backup first.

## Implementation status

The web, desktop and browser extension clients implement the registry, the namespaces above, creation with an automatic distinct color, renaming, recoloring, switching by restart and removal. The extension runs its one peer in an offscreen document, so it runs one profile at a time across all its pages: the document reads the registry when it starts and holds that profile's peer lock; after a switch, the next page to connect has the service worker stop that peer, close the document and open a new one on the profile now in use, and every other open page reloads as that profile. An install from before profiles is the default profile, with nothing moved. Checking other profiles is implemented in all three clients (`ProfilePeek` in the peer, the pace and the "New" store in the page) and covered by unit tests with a fake DHT (a waiting text and held items seen, a text already taken not counted, a forged envelope ignored, the read path rule, the per-profile budget and turn-taking, the relays' budget as a wait, no publication), UI tests of the switcher and the account bar, and a browser end-to-end test with two profiles in one browser. Covered by unit tests (registry, color assignment, isolation of chats including the default prefix and other storage spaces, profile-scoped clearing, removal: shared Ark databases kept, running and locked profiles refused, inherited lock) and a browser end-to-end test that creates a second profile, checks its empty chats, own settings and color, switches back and removes it; for the extension, unit tests of the offscreen restart (one peer at a time, the lock, a stopped service worker) and an end-to-end test that creates and switches profiles and restores a backup into a new one.

## Open decisions and conformance

Running two profiles at once in separate windows; moving a chat between profiles. Conformance: an implementation MUST keep every linked item above within its profile, MUST NOT disclose profiles on the wire, and MUST restart (or fully stop) the previous profile's peer on switching.

## Revision log

One file per change in [changes/04-profiles/](changes/04-profiles/) ([how](00-process.md#revisions)). The site lists them here, newest first, and derives the Revision and Updated rows from them.
