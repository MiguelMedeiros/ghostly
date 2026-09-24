# WISP 04 — Local Profiles

| Field | Value |
|---|---|
| Candidate number | 04; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-23 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [01](01-ghost-core.md), [02](02-peer-keys.md), [200](200-payments.md), [700](700-local-services.md) |
| Implementation | Experimental: web and desktop clients; the browser extension runs one profile |

> This is a review draft. Candidate numbers are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md) and [implementation evidence](IMPLEMENTATION.md).

## Scope

A **profile** is a local container on one device. It holds everything a person may want to keep apart — for example "Personal" and "Work" — and exactly one profile is active in a running client. A profile is not a protocol identity: contacts never learn that profiles exist, how many there are, or their names. Each chat already has its own keys ([02](02-peer-keys.md)); a profile groups chats and everything tied to them.

Number note: legacy reader paths once used `04` for capability negotiation (now [03](03-capabilities.md)). Per the [numbering map](NUMBERING.md), the current number takes precedence; the old `04-capabilities` alias still resolves.

## What belongs to a profile

| Linked to the profile | Where it lives |
|---|---|
| Chats and their keys, messages, files, drafts, read and pin state | Profile storage namespace and peer database |
| Wallets: Cashu proofs, Ark and USDT seeds and configuration, payment-intent journal ([200](200-payments.md)) | Peer database |
| Ways of paying chosen per chat | That chat's record, inside the profile |
| Shared local web apps and per-contact grants ([700](700-local-services.md)) | Peer database |
| Wallet backups and restores | A backup is made from, and restored into, the active profile |
| Settings: color theme, light/dark mode, language, nickname, notifications, lock screen, network | Profile settings record |
| Wallet mode (Mainnet or Testnet) and each mode's wallets ([200](200-payments.md)) | Peer database |
| Profile picture, shown to paired contacts with the nickname ([401](401-paired-chat.md)), and whether contacts are told either (on unless switched off); the names and pictures contacts sent, with their chats | Peer database |
| Optional identity proofs (300 series) | Planned; disabled in this release |

Nothing crosses profiles. A contact of one profile cannot reach an app, a wallet or a chat of another.

## Local model

The device keeps one registry, the only record shared by all profiles:

```json
{ "version": 1, "active": "<id>", "profiles": [{ "id": "", "name": "Personal", "createdAt": 0 }] }
```

- `id` is empty for the **default profile** or ten characters `[a-z0-9]`. The default profile keeps the storage names clients used before profiles existed, so upgrading moves no data.
- `name` is 1–32 characters after collapsing whitespace. It is a local label, distinct from the nickname shown to contacts.
- A missing or corrupt registry is read as a single default profile. An unknown `active` falls back to the default profile.

Each profile `p` maps to separate namespaces: storage prefix `ghostly_` (default) or `ghostly_<p>_`; peer database `ghostly` or `ghostly_<p>`; single-peer lock `ghostly-peer` or `ghostly-peer-<p>`; settings record `ghostly_app_settings` or `ghostly_<p>_app_settings`. Because the default prefix is also the start of every other profile's keys, a client MUST NOT treat a key of the form `ghostly_<10 characters>_…` as the default profile's.

## Creating, editing and switching

- **Create** asks only for a name. The new profile starts empty, inherits the current language, light/dark mode and lock screen (password included), and receives a color theme that no existing profile uses (cyan, purple, classic, monochrome, then cycling), so the switch is visible at once.
- **Edit**: name and color can be changed at any time from the profile page; the color is part of the profile's settings.
- **Switch** persists `active` and restarts the client. No peer connection, wallet, timer or cached state of the previous profile may keep running beside the new one. Contacts of the previous profile see it go offline, as when the app closes.
- **The account switcher** (web and desktop) lists the saved profiles from the account bar's Profile place (a chevron, a right-click, a long press, or Alt+Shift+P) and, on a phone, from Settings (its row, or holding the Settings tab). One tap switches. Each profile reopens on the page it was left on (never an address carrying keys). While the client restarts, the target's picture and name cover the page. A locked profile shows its lock screen, naming it, before anything of it renders. For profiles that are not running, the switcher reads only local data: the picture from the profile's peer database, and the messages left unread in its chats (groups are not counted). Nothing new reaches a profile that is not running, so this count is what was there when it was left. A locked profile shows neither its picture nor its count, only that it is locked.
- **Remove** deletes a profile for good: its local keys, its peer database, and the databases of its Ark wallets that no other profile references; then its registry entry. The first profile and the active one cannot be removed, nor one that another window is running (its peer lock `ghostly-peer-<ns>` is held). The client shows what the profile holds (chats, sats, wallets, apps), offers a backup ([05](05-backups.md)) first, and asks for the profile's name to confirm.
- A client MAY run a process in its own storage space (desktop `GHOSTLY_PROFILE`, for testing): its registry and namespaces are prefixed with that space, and the default profile of the unprefixed space never treats another space's keys as its own.

## Security and privacy

- Profiles separate data, not network presence. Two profiles on one device share its network address and timing; an observer may correlate them. Use separate devices when that matters.
- The lock screen is a setting of each profile and applies when that profile starts; a new profile inherits it, so creating one is not a way around the lock. Reading another profile's data from the active one (a backup of it) or removing it requires that profile's lock password when it has a lock.
- "Clear all data" removes the active profile's data only, never the registry or another profile. Removing a profile deletes its wallets with it; the client says so and offers a backup first.

## Implementation status

The web and desktop clients implement the registry, the namespaces above, creation with an automatic distinct color, renaming, recoloring, switching by restart and removal. The browser extension runs its peer outside the page and offers one profile. Covered by unit tests (registry, color assignment, isolation of chats including the default prefix and other storage spaces, profile-scoped clearing, removal: shared Ark databases kept, running and locked profiles refused, inherited lock) and a browser end-to-end test that creates a second profile, checks its empty chats, own settings and color, switches back and removes it.

## Open decisions and conformance

Running two profiles at once in separate windows; moving a chat between profiles; binding identity proofs per profile. Conformance: an implementation MUST keep every linked item above within its profile, MUST NOT disclose profiles on the wire, and MUST restart (or fully stop) the previous profile's peer on switching.
