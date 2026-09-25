# WISP 05: Profile Backups

| Field | Value |
|---|---|
| Candidate number | 05; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.2 |
| Updated | 2026-09-25 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [04](04-profiles.md), [200](200-payments.md), [1000](1000-storage.md) |
| Implementation | Experimental: web and desktop clients |

> This is a review draft. Candidate numbers and formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md).

## Scope

A **profile backup** captures one local profile ([04](04-profiles.md)) completely, so it can be brought back on this or another device: chats and their keys, messages and files, wallets and their payment journal, shared services and grants, per-chat payment choices and settings. It is one opaque, encrypted **bundle**. Where a bundle is kept (a file, an S3 bucket) is the concern of storage adapters ([1000](1000-storage.md)); this document defines what a bundle is.

Per-wallet backups defined by [202](202-arkade.md) and the USDT scope remain valid for moving a single wallet. A profile backup contains them.

## Envelope

A bundle is UTF-8 JSON. Only what is needed to decrypt it is in the clear:

```json
{
  "format": "ghostly-backup",
  "version": 1,
  "kdf": { "name": "PBKDF2-SHA256", "iterations": 600000, "salt": "<base64url, 16 bytes>" },
  "cipher": { "name": "AES-256-GCM", "iv": "<base64url, 12 bytes>" },
  "compression": "gzip",
  "ciphertext": "<base64url>"
}
```

- The key is derived from a passphrase of at least 12 characters chosen when the backup is made. Salt and IV are random per bundle.
- `compression` is `gzip` or `none` and applies to the plaintext before encryption.
- The clear header is authenticated as AES-GCM associated data: the UTF-8 of `format`, `version`, `kdf.name`, `kdf.iterations`, `kdf.salt`, `cipher.name`, `cipher.iv` and `compression`, joined by `\n`. Changing any of it makes the bundle fail to open.
- A reader MUST bound what it reads: this client refuses bundles whose decompressed payload exceeds 1 GiB.
- The envelope carries no profile name, date, device or size hint beyond its own length. Storage metadata ([1000](1000-storage.md)) is likewise non-identifying.
- A reader MUST reject an unknown `format`, a higher `version`, fewer than 600 000 iterations, or a failed GCM tag, and MUST NOT act on any part of a bundle that failed authentication.

## Payload

The decrypted, decompressed payload is JSON:

```json
{
  "format": "ghostly-profile",
  "version": 1,
  "createdAt": 1790000000000,
  "profile": { "name": "Work" },
  "storage": { "<key suffix>": "<value>" },
  "databases": { "peer": { "version": 6, "stores": [ … ] }, "ark": { "<wallet id>": { … } } }
}
```

- `storage` holds the profile's local keys with the profile prefix removed (for example `app_settings`, a chat id). Restore writes them under the new profile's prefix.
- `databases.peer` is a snapshot of the profile's peer database: for each object store its name, key path, auto-increment flag, indexes, keys and values. `databases.ark` holds each Ark wallet's own database ([202](202-arkade.md)), keyed by wallet id.
- Values that JSON cannot carry are tagged: `{"$ghostly":"bigint","value":"…"}`, `{"$ghostly":"bytes","value":"<base64url>"}`, `{"$ghostly":"blob","type":"<mime>","value":"<base64url>"}`.
- Data of the profile's own that has a `$ghostly` key (a contact can send anything) is escaped as `{"$ghostly":"object","entries":[[key, value], …]}`, so it comes back as it was and never as a tag. A reader leaves a tag it cannot read as it is instead of failing the restore.
- Files whose bytes are in the platform's file storage (the origin-private file system, or real files on Desktop; see [500](500-files.md)) rather than in the database travel as a `blob` on their record when they are at most 16 MiB, so pictures and voice messages come back. Larger ones stay out and show as no longer available after a restore. The store of file pieces is kept empty in the bundle.
- Wallet seeds inside the peer database stay sealed as they are on the device; their device keys travel with them, inside the encrypted bundle. The bundle passphrase therefore protects the funds: anyone with bundle and passphrase can spend them.

## Restore

- A bundle is restored into a **new** profile. It never replaces, merges into or deletes an existing profile.
- Every store and key is written before the profile is registered, so an interrupted restore leaves no half-made profile in the list.
- Every Ark wallet record gets a fresh wallet id, with or without a database to copy, so a restored profile never shares an Ark database with the profile it came from. A backup of a wallet whose database exists but cannot be read fails instead of leaving it out.
- Payment attempts that were `pending`, `submitted` or `unknown` in the bundle are marked `unknown`: an older backup cannot prove an attempt was never sent, and nothing restored may authorize a new send ([200](200-payments.md)).
- After restore the client switches to the new profile ([04](04-profiles.md)).

## Security and operation

- **Two live copies.** Restoring on a second device while the original still runs makes both answer for the same chats and hold the same keys. Contacts may see messages arrive at one copy only; wallets may race on the same funds. Treat a bundle as a move unless you know both copies will not run together.
- **Staleness.** A bundle reflects the moment it was made. Ecash spent later, Lightning quotes, Ark renewals and payments made afterwards are not in it. Restoring an old bundle can show ecash already spent; the wallet discovers that at the mint.
- **Secrets at rest.** The bundle is as sensitive as the device. Storage credentials for remote adapters ([1002](1002-s3-storage.md)) are never part of a bundle.

## Implementation status

The web and desktop clients create bundles from the active profile (or another one, with its lock password), restore them into a new profile and switch to it; storage through the local file and S3-compatible adapters. Covered by unit tests (round trip of every store including file blobs and wallet records, tag-shaped data, Ark database relocation, rejected passphrase, tampered ciphertext and header) and end-to-end tests that back a profile up to a file and to an S3-compatible server and restore it.

## Open decisions

Incremental and scheduled backups; including files over 16 MiB by choice; a passphrase-less mode tied to a hardware key; key rotation; restoring into an existing profile by merge.

## Revision log

- 0.2 (2026-09-25): files kept in file storage travel up to 16 MiB; larger ones stay out.
- 0.1 (2026-09-23): initial review draft.
