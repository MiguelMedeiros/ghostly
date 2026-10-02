# WISP 04: Local Profiles

| Field | Value |
|---|---|
| Candidate number | 04; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [01](01-ghost-core.md), [02](02-peer-keys.md), [200](200-payments.md), [700](700-local-services.md) |
| Implementation | Experimental: web, desktop and browser extension clients; the headless CLI keeps a profile per folder ([11xx](11xx-headless.md)) |
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
- The default profile starts with the built-in name `"Personal"`, which the client shows in the app's language until the user renames it. A backup of it carries `"Personal"` as written, never the translated name, so the profile restored from it follows the language too. A restored name that is the default profile's name in any language the client speaks (`Pessoal`, `個人`, as clients wrote it in backups before) is read as `"Personal"`.
- `restored: true` marks a profile brought back from a backup ([05](05-backups.md)). The client shows its name with the word for "restored" in the app's language; the registry keeps only the name, and a backup of it carries only the name. A client lets the user edit the name alone, never the word, and renaming keeps the mark; the user takes it off on purpose. A name ending in the word in parentheses in any language the client speaks (` (restored)`, as clients wrote it before the mark, ` (restaurado)`, `（復元）`) is read, renamed and restored as the name without it, marked.
- A missing or corrupt registry is read as a single default profile. An unknown `active` falls back to the default profile.

Each profile `p` maps to separate namespaces: storage prefix `ghostly_` (default) or `ghostly_<p>_`; peer database `ghostly` or `ghostly_<p>`; single-peer lock `ghostly-peer` or `ghostly-peer-<p>`; settings record `ghostly_app_settings` or `ghostly_<p>_app_settings`. Because the default prefix is also the start of every other profile's keys, a client MUST NOT treat a key of the form `ghostly_<10 characters>_…` as the default profile's.

## Creating, editing and switching

- **Create** asks only for a name. The new profile starts empty, inherits the current language, light/dark mode and lock screen (password included), and receives a color theme that no existing profile uses (cyan, purple, classic, monochrome, then cycling), so the switch is visible at once.
- **Edit**: name and color can be changed at any time from the profile page; the color is part of the profile's settings.
- **Switch** persists `active` and restarts the client. No peer connection, wallet, timer or cached state of the previous profile may keep running beside the new one. Contacts of the previous profile see it go offline, as when the app closes. `active` is what the next start opens; a running client stays the profile it started as. A web tab that waited for another tab to close takes over as the profile it opened with, even when the other tab chose another one meanwhile, and names, lock checks, wake-up push and switching all follow the profile it runs.
- **The account switcher** (web and desktop) lists the saved profiles from the account bar's Profile place (a chevron, a right-click, a long press, or Alt+Shift+P) and, on a phone, from Settings (its row, or holding the Settings tab). One tap switches. Each profile reopens on the page it was left on (never an address carrying keys). While the client restarts, the target's picture and name cover the page. A locked profile shows its lock screen, naming it, before anything of it renders. For profiles that are not running, the switcher reads only local data: the picture from the profile's peer database, and the messages left unread in its chats (groups are not counted). Nothing new reaches a profile that is not running, so this count is what was there when it was left. What is waiting for it since then is shown apart, as "New" (see [Checking other profiles](#checking-other-profiles)). A locked profile shows neither its picture nor its counts, only that it is locked.
- **Remove** deletes a profile for good: its local keys, its peer database, and its wallets' own storage that no other profile references (each Ark wallet's database, each Bark wallet's two, each Fedimint federation's client file); then its registry entry. The first profile and the active one cannot be removed, nor one that another window is running (its peer lock `ghostly-peer-<ns>` is held). The client shows what the profile holds (chats, sats, wallets, apps), offers a backup ([05](05-backups.md)) first, and asks for the profile's name to confirm.
- A client MAY run a process in its own storage space (desktop `GHOSTLY_PROFILE`, for testing): its registry and namespaces are prefixed with that space, and the default profile of the unprefixed space never treats another space's keys as its own.

## Checking other profiles

Only the running profile is online. What a contact sends to another profile of the device waits with the contact: a short text in the contact's DHT mailbox ([403](403-dht-text.md)), items held under a hold/1 pointer ([4xx](4xx-store-and-forward.md)). A client MAY look there now and then, from the running profile, so the person knows something waits without switching. When it does:

- **What it reads.** For each other profile, its paired chats as that profile stored them (never entry sessions), and for each chat the one mailbox the chat would read first (the pinned one once the contact uses it, the invite's before) and, when that profile accepts held items, the contact's hold pointer. For each community group it is in, the group's beacon, whose head names the newest frame a hub holds ([9xx · Group Community § Head](9xx-group-community.md#head)). Nothing else: no capability record, no presence, no manifest, no bundle, no frame.
- **Mesh groups** are not covered: nothing on the network says a member has frames waiting ([9xx · Group Mesh](9xx-group-mesh.md#security-and-privacy)).
- **What it keeps.** A DHT envelope's sequence, text and receipt share one sealed record, and the contact republishes a keep-alive envelope every few minutes, so only opening it tells a text from a keep-alive. The envelope is opened and its signature checked exactly as the chat would (a copy of the invite can write to the invite's mailbox; an unchecked "new" could be forged). What is kept is whether it carries a text that chat has not taken yet, and the text's id; the words are dropped unread. A hold pointer gives the number of items held beyond what the profile took. A community group's head is the identity of a frame (sender, epoch, sequence, time); it is new when that profile's stored state has not taken it. A rejected alternative read the record's TTL, which differs between a text and a keep-alive envelope, without opening it: it is not part of [403](403-dht-text.md), and it cannot tell a text already taken from a new one.
- **What it never does.** It publishes nothing, writes nothing in the other profile's storage (its database is opened read-only, without a version, and closed at once; its local storage is only read), fetches no held bundle and opens no link. The other profile's state does not move: when it runs, its own chats fetch as usual. What was seen is kept in the running client, beside the registry (`<registry>-peek`), until that profile runs; a text stays marked after its envelope expires. The profile clears it when it starts.
- **Which profiles.** Not a locked one (it shows nothing, as before), not one another window runs (it is online itself), and not one that reads the network another way than the running one: another set of relays, or relays where the running one reads the DHT (desktop "Also use Pkarr relays"). Reading such a profile's records over the running profile's path would show that path something the other profile never sends there.
- **Pace and budget.** About every three minutes with ±15% jitter (a DHT text stays in its mailbox five minutes, and an unconfirmed one is sent again for about an hour), four times slower while the client is hidden and twice slower on battery where the platform says so. Each profile has its own budget: at most 6 reads a round and 18 in any ten minutes, chats taken in turn. Reads are background requests; the relays' request budget is a wait, which ends the round.
- **Signals.** The account switcher shows "New" beside a profile with something waiting, apart from its unread count; the running profile's picture gets a dot besides the ring. A system notice "New message in <profile>" is off by default, needs system notifications on, is not shown when every such chat is muted in that profile, and follows the system's Do Not Disturb. Clicking either switches to that profile.
- **Setting.** "Check other profiles" is on by default in the desktop client and off in the web client and the extension. Desktop reads the DHT itself, so its reads spread over DHT nodes, and its request budget is not the relays'. The web and the extension read through two relay operators, which would see both profiles' reads from one address at the same moment, and share a 30-request-a-minute budget per relay with every chat. Turned off, nothing is read.
- **Privacy.** With the same read path, the network learns nothing it could not learn anyway: the records read are the ones that profile reads when it runs, from the same device and address, over the same relays or DHT. What changes is timing: the reads happen while another profile runs, so an observer of the path can link the two profiles' reads by time as well as by address (see Security and privacy). A client that must avoid that correlation leaves the setting off.

## Security and privacy

- Profiles separate data, not network presence. Two profiles on one device share its network address and timing; an observer may correlate them. Use separate devices when that matters.
- Checking other profiles reads another profile's records while this one runs. With the same read path it adds no new link to the network beyond the shared address, only timing; it is off by default where reads go through relay operators.
- The lock screen is a setting of each profile and applies when that profile starts; a new profile inherits it, so creating one is not a way around the lock. Reading another profile's data from the active one (a backup of it) or removing it requires that profile's lock password when it has a lock.
- "Clear all data" removes the active profile's data only, never the registry or another profile, and all of it but its wallets: its local keys (chats, drafts, settings, lock screen, backup storage), its files, and in its peer database the chats, messages, groups and shared apps, its identity proofs and their keys, its DID and its key, its own Nostr data and the public profiles it read, and from the settings record everything that is not a wallet's (nickname, picture, network settings, the storage for held items, the push subscription). The wallets stay (their records, proofs, payments, quotes, history and journal, and their own databases and files): ecash is money and nothing else holds a copy of it; the confirmation lists what goes and says the wallets stay. Before deleting, the peer takes back what it can, best effort and for a few seconds at most, never holding up the local wipe: it deletes the items it holds for contacts and their manifests from storage, publishes a `deactivated` record for a DID it ever published ([3xx](3xx-did-dht.md)), and publishes once more the revocation record of every identity proof it ever shared ([300](300-peer-proofs.md)); then it stops, so nothing it holds in memory is written back. The page ends the push subscription at the push service. Proofs posted on other sites (a Bluesky record, a Pubky file, a DNS record) and backups already saved stay where they are. Removing a profile deletes its wallets with it; the client says so and offers a backup first.

## Implementation status

The web, desktop and browser extension clients implement the registry, the namespaces above, creation with an automatic distinct color, renaming, recoloring, switching by restart and removal. The extension runs its one peer in an offscreen document, so it runs one profile at a time across all its pages: the document reads the registry when it starts and holds that profile's peer lock; after a switch, the next page to connect has the service worker stop that peer, close the document and open a new one on the profile now in use, and every other open page reloads as that profile. An install from before profiles is the default profile, with nothing moved. Checking other profiles is implemented in all three clients (`ProfilePeek` in the peer, the pace and the "New" store in the page) and covered by unit tests with a fake DHT (a waiting text and held items seen, a text already taken not counted, a forged envelope ignored, the read path rule, the per-profile budget and turn-taking, the relays' budget as a wait, no publication), UI tests of the switcher and the account bar, and a browser end-to-end test with two profiles in one browser. Covered by unit tests (registry, color assignment, isolation of chats including the default prefix and other storage spaces, profile-scoped clearing, removal: shared Ark databases kept, running and locked profiles refused, inherited lock) and a browser end-to-end test that creates a second profile, checks its empty chats, own settings and color, switches back and removes it; for the extension, unit tests of the offscreen restart (one peer at a time, the lock, a stopped service worker) and an end-to-end test that creates and switches profiles and restores a backup into a new one.

## Open decisions and conformance

Running two profiles at once in separate windows; moving a chat between profiles. Conformance: an implementation MUST keep every linked item above within its profile, MUST NOT disclose profiles on the wire, and MUST restart (or fully stop) the previous profile's peer on switching.

## Revision log

One file per change in [changes/04-profiles/](changes/04-profiles/) ([how](00-process.md#revisions)). The site lists them here, newest first, and derives the Revision and Updated rows from them.
