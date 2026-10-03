# WISP 05: Profile Backups

| Field | Value |
|---|---|
| Candidate number | 05; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [04](04-profiles.md), [200](200-payments.md), [1000](1000-storage.md) |
| Implementation | Experimental: web, desktop and browser extension clients; the headless CLI seals its own profile folder in the same envelope, restored only by the CLI ([11xx](11xx-headless.md)) |
| Summary | Bring a whole profile back from one bundle, sealed with a passphrase unless the person chooses otherwise. |
| Availability | Available |
| Notes | Web, desktop and extension; the CLI backs up its own profiles to a file. A restore always creates a new profile; nothing is overwritten. |
| Feature | [Your space](https://ghostly.tools/#space) |

> This is a review draft. Candidate numbers and formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md).

## Scope

A **profile backup** captures one local profile ([04](04-profiles.md)) completely, so it can be brought back on this or another device: chats and their keys, messages and files, wallets and their payment journal, shared services and grants, per-chat payment choices and settings. It is one **bundle**, encrypted with a passphrase unless the person explicitly chooses a bundle without one. Where a bundle is kept (a file, an S3 bucket) is the concern of storage adapters ([1000](1000-storage.md)); this document defines what a bundle is.

Per-wallet backups defined by [202](202-arkade.md) and the USDT scope remain valid for moving a single wallet. A profile backup contains them.

## Envelope

A bundle is a file read from its first byte to its last, never whole in memory. It starts with one line of UTF-8 JSON, the **header**, ended by a line feed, and continues with **frames** until the end of the file. This is envelope version 2. Version 1, one JSON document, is described under [Version 1](#version-1); writers make version 2, readers accept both.

```
{"format":"ghostly-backup","version":2,"protection":"passphrase","kdf":{"name":"PBKDF2-SHA256","iterations":600000,"salt":"<base64url, 16 bytes>"},"cipher":{"name":"AES-256-GCM","nonce":"<base64url, 7 bytes>"}}\n
frame, frame, ..., final frame
```

A frame is `kind` (1 byte), `length` (4 bytes, big endian), then `length` bytes of body. Kinds:

| Kind | Body (once opened) |
|---|---|
| 1 | One piece of JSON, gzip-compressed |
| 2 | One piece of JSON, as it is (a writer without gzip) |
| 3 | Bytes of the file the JSON before them announced, at most 1 MiB |
| 255 | The final marker: empty |

- **Only what is needed to open the bundle is in the clear**: the header. It carries no profile name, date, device or size. Frame kinds and lengths are visible, so the number and rough sizes of a profile's files can be told from a bundle; their names, types and bytes cannot.
- `protection` is `passphrase` or `none`.
- **`passphrase`.** The key is derived from a passphrase of at least 12 characters chosen when the backup is made, as in version 1: PBKDF2-SHA256, at least 600 000 iterations, a random 16-byte salt per bundle. Every frame is sealed on its own with AES-256-GCM, so a reader holds one frame at a time. A frame's 12-byte nonce is the header's 7 random bytes, the frame's number (4 bytes, big endian, from 0) and its kind (1 byte). Its associated data is the SHA-256 of the header line, line feed included. The body is the ciphertext followed by the 16-byte tag. A frame that was changed, moved, dropped, repeated or given another kind fails to open, and so does every frame under a changed header. The final marker is sealed like any other frame: a bundle that ends without it, or continues after it, was cut or extended and is refused.
- **`none`.** Nothing is encrypted: the header has no `kdf` or `cipher`, and `"check":{"name":"SHA-256-chain"}` instead. The chain starts as the SHA-256 of the header line; after each frame it becomes the SHA-256 of the chain so far followed by the frame as written (kind, length, body). The final marker's body is the chain's last value, 32 bytes. A damaged or cut file is refused. The chain proves nothing about who made the file: anyone can make a valid one.
- A reader MUST reject an unknown `format`, a higher `version`, an unknown `protection`, fewer than 600 000 iterations, a frame that fails its check, a bundle without its final marker, and a `db` record whose `version` is higher than its own database's (a newer client's profile, which it could restore but not open), and MUST NOT act on a frame before that frame passed its check. Because frames are checked one at a time, a restore writes as it reads; it MUST take back everything it wrote when a later frame fails or the final marker is missing (see Restore).
- A reader MUST bound what it reads: this client refuses a frame over 64 MiB and a piece of JSON over 256 MiB once decompressed. The size of a bundle is bounded only by the device's storage.
- A writer MUST NOT write a frame a reader would refuse (this client: over 64 MiB), and MUST stop at the first frame its storage does not take (no room left, say): frames are numbered and chained, so a bundle that goes on after a gap never opens again. A backup that stops this way fails and says why; it is not a bundle with a file left out.
- Storage metadata ([1000](1000-storage.md)) is non-identifying, as before.

### A backup without a passphrase

`protection: "none"` exists for a person who chooses it: a copy for a disk they already encrypt, or a move between their own devices. It is never a default.

- A client MUST make one only on an explicit choice, after saying plainly that the file holds the profile's keys, chats and wallet secrets in the clear and that anyone who gets the file gets everything in it, including any money in its wallets. When the profile has Mainnet wallets that have held money, it says that specifically. This client asks for a second confirmation, and does not send such a bundle to remote storage ([1002](1002-s3-storage.md)).
- A restore reads the header, asks for no passphrase, and shows that the file was not protected.
- The headless CLI makes one only with `--no-passphrase`; given neither that nor a passphrase it makes nothing, and given both it refuses ([11xx](11xx-headless.md)).

## Payload

The opened frames are a sequence of records. A JSON frame is one record; byte frames belong to the `file` record before them. Records, in order:

```json
{ "t": "profile", "format": "ghostly-profile", "version": 2, "createdAt": 1790000000000,
  "profile": { "name": "Work", "builtIn": false }, "storage": { "<key suffix>": "<value>" },
  "files": 212, "bytes": 524288000 }
{ "t": "db", "db": "peer", "version": 10, "stores": [ { "name": "links", "keyPath": "id", "autoIncrement": false, "indexes": [] }, … ] }
{ "t": "rows", "db": "peer", "store": "settings", "keys": [ … ], "values": [ … ] }
{ "t": "ark", "walletId": "<wallet id>", "snapshot": { … } }
{ "t": "file", "row": { "id": "…", "linkId": "…", "metadata": { … } }, "size": 1048576, "type": "image/png" }
… byte frames, `size` bytes in all …
{ "t": "file-end", "ok": true }
{ "t": "end", "files": 212, "bytes": 524288000 }
```

- `profile` comes first. `profile.name` is the profile's name as the registry keeps it ([04](04-profiles.md)). `profile.builtIn` says whether that is the built-in name of the default profile never renamed (`true`, with `name` `"Personal"`), which the restored profile shows in the app's language, or a name the user gave (`false`), which is restored exactly as written, even when it is the word a language uses for the built-in name. A writer always sets it. A reader that finds none (bundles made before the marker), or a value that is not a boolean, takes the name as built-in only when it is `"Personal"` or the default profile's name in the language of the bundle's own `app_settings` (English when they set none), which is how clients wrote the default profile then; any other name is kept as written. `files` and `bytes` say how many files follow with their bytes, and how many bytes, so a restore can show its progress.
- `storage` holds the profile's local keys with the profile prefix removed (for example `app_settings`, a chat id). Restore writes them under the new profile's prefix.
- `db` gives the peer database's version and the shape of each object store (name, key path, auto-increment flag, indexes). `rows` records follow, each a batch of one store's keys and values. The `settings` and `links` stores come first, so a reader can tell whose profile a bundle is before writing anything (see Restoring on the same device).
- `ark` holds one Ark wallet's own database ([202](202-arkade.md)), by wallet id.
- Values that JSON cannot carry are tagged: `{"$ghostly":"bigint","value":"…"}`, `{"$ghostly":"bytes","value":"<base64url>"}`, `{"$ghostly":"blob","type":"<mime>","value":"<base64url>"}`.
- Data of the profile's own that has a `$ghostly` key (a contact can send anything) is escaped as `{"$ghostly":"object","entries":[[key, value], …]}`, so it comes back as it was and never as a tag. A reader leaves a tag it cannot read as it is instead of failing the restore.
- **Files.** Every file whose bytes are all on the device travels with them, whatever its size and wherever the device keeps them (in the database, in the origin-private file system, or as real files on Desktop; see [500](500-files.md)): a `file` record with the file's record (`row`, with what changed about it since it was stored), its size and type, then the bytes in frames of at most 1 MiB, then `file-end`. `ok: false` means the device could no longer read the file after it began; a reader keeps the record and drops the bytes. The stores `files` and `fileState` carry as rows only the files that travel without bytes: a transfer still under way, or bytes this device no longer has. The store of file pieces is kept empty.
- On restore a file of at most 16 MiB becomes a Blob on its record; a larger one goes to the restoring platform's file storage, in the new profile's own space. A file id that is not a plain name (letters, digits, `_`, `-`) is refused: it names a file on disk.
- `end` comes last and repeats how many files travelled with their bytes and how many bytes. A reader MUST check it against what it restored.
- A reader ignores a record whose `t` it does not know.
- Wallet seeds inside the peer database stay sealed as they are on the device; their device keys travel with them. In a sealed bundle the passphrase therefore protects the funds: anyone with bundle and passphrase can spend them. In a bundle without a passphrase, the file alone is enough.

### What a bundle does not hold

- Storage credentials for remote adapters ([1002](1002-s3-storage.md)), on the page and in the peer's settings.
- The device's push subscription ([401](401-paired-chat.md)): it belongs to the browser that made it.
- The bytes of a file still arriving, or no longer on the device. Its message and record are kept.
- The local databases of Bark ([204](204-bark.md)), Spark and Fedimint wallets. Their recovery phrases are in the bundle; the wallets rebuild their state from the phrase and their servers.

### Version 1

Bundles made before version 2 are one UTF-8 JSON document, and are still restored:

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

- Always sealed with a passphrase. `compression` is `gzip` or `none` and applies to the plaintext before encryption. The clear header is authenticated as AES-GCM associated data: the UTF-8 of `format`, `version`, `kdf.name`, `kdf.iterations`, `kdf.salt`, `cipher.name`, `cipher.iv` and `compression`, joined by `\n`.
- The plaintext is one JSON object: `{ "format": "ghostly-profile", "version": 1, "createdAt", "profile", "storage", "databases": { "peer": { "version", "stores": [ … with keys and values ] }, "ark": { "<wallet id>": { … } } } }`.
- Files in the platform's file storage travel as a `blob` on their record when they are at most 16 MiB; larger ones are not in a version 1 bundle and show as no longer available after a restore.
- A reader refuses a version 1 bundle whose decompressed payload exceeds 1 GiB.
- A reader tells the versions apart by the first line: a version 2 bundle starts with a JSON line saying `"version":2`; a version 1 bundle is a single JSON object with no line end before its ciphertext.

## Restore

- A bundle is restored into a **new** profile. It never replaces, merges into or deletes an existing profile.
- Every store, file and key is written before the profile is registered, so an interrupted restore leaves no half-made profile in the list.
- A restore that fails, is cancelled, or meets a frame that does not pass its check takes back everything it wrote: its databases, the files in the new profile's space and its local keys. Nothing of a refused bundle stays on the device.
- A client shows what a backup or a restore is doing (reading, writing, checking; files and bytes done of the total) and offers Cancel. A cancelled backup leaves no file, whole or partial.
- Every Ark wallet record gets a fresh wallet id, with or without a database to copy, so a restored profile never shares an Ark database with the profile it came from. So does every Bark wallet record ([204](204-bark.md)), current or retired: its databases are never in the bundle, and under the new id the wallet starts an empty one that the server's recovery scan fills from the phrase. A backup of a wallet whose database exists but cannot be read fails instead of leaving it out.
- Payment attempts that were `pending`, `submitted` or `unknown` in the bundle are marked `unknown`: an older backup cannot prove an attempt was never sent, and nothing restored may authorize a new send ([200](200-payments.md)).
- Every Cashu proof restored that no payment holds is marked as a copy to check. When its wallet starts, it asks each mint once which of those proofs are still unspent (NUT-07, [201](201-cashu.md)) and drops the ones the mint reads spent, so the balance is what the mints still hold and not what the bundle held. A mint that cannot be asked is asked again later; until it answers, its proofs count as before.
- After restore the client switches to the new profile ([04](04-profiles.md)).

### Restoring on the same device

A restored copy keeps the chat keys of the profile it was made from (and its DID key, [3xx](3xx-did-dht.md)). When that profile is still on the device, both would answer the same contacts as one person (see Two live copies). So before writing anything, the client opens the bundle and compares it with every profile of the device, locked ones included: a profile matches when it shares a chat's participation key (or, for a chat from before them, its chat key) or the DID key with the bundle. Only the matching profiles' names are shown. With a match, the client says both would act as the same person to contacts, suggests replacing the original or not running both, and offers:

- **Replace the original**: the bundle is restored as a new profile and the client switches to it, then opens the original's removal ([04](04-profiles.md) § Remove) with its usual checks (what it holds, a backup first, its name, its lock password). The original is never removed without them: it may hold newer wallet state than the bundle. Not offered for the first profile, which cannot be removed; the client says to clear its data instead. Not offered where the client cannot switch profiles.
- **Restore as a copy anyway**: restored as without a match.
- **Cancel**: nothing is written.

Without a match the bundle is restored at once.

## Security and operation

- **Two live copies.** Restoring on a second device while the original still runs makes both answer for the same chats and hold the same keys. Contacts may see messages arrive at one copy only; wallets may race on the same funds. Treat a bundle as a move unless you know both copies will not run together.
- **Staleness.** A bundle reflects the moment it was made. Ecash spent later, Lightning quotes, Ark renewals and payments made afterwards are not in it. Restoring an old bundle brings back ecash already spent: the wallet asks its mints when it starts and drops it (see Restore).
- **Secrets at rest.** The bundle is as sensitive as the device. Storage credentials for remote adapters ([1002](1002-s3-storage.md)) are never part of a bundle.

## Implementation status

The web, desktop and browser extension clients create bundles from the active profile (or another one, with its lock password), restore them into a new profile and switch to it; storage through the local file and S3-compatible adapters. A bundle is staged in the device's file storage as it is written and then saved: through the system's save dialog on Desktop, as a download in a browser. Bundles for S3 are sent in one request, so they are read into memory once to send. Covered by unit tests (the envelope: round trip, wrong passphrase, a changed, moved, dropped, repeated or retyped frame, a changed header, a cut file, a bundle without a passphrase and its damage; the profile: round trip of every store, files kept as Blobs and in file storage, files over 16 MiB, another profile's files, a file the device can no longer read, a version 1 bundle, wallet records and Ark database relocation, a refused or cancelled restore leaving nothing, a cancelled backup leaving no file, a bundle matched to the profile it was made from by a chat key or the DID key and not to another), UI tests of the progress, Cancel, the choice to go without a passphrase and its warnings, the same-device warning and its three answers, and end-to-end tests in Chromium and WebKit that back a profile with files up to a file, with and without a passphrase, and restore it, and to an S3-compatible server (the extension: to a file).

## Open decisions

Incremental and scheduled backups; leaving large files out by choice; sending a bundle to S3 in parts instead of one request; a passphrase-less mode tied to a hardware key; key rotation; restoring into an existing profile by merge; copying the local databases of Bark, Spark and Fedimint wallets.

## Revision log

One file per change in [changes/05-backups/](changes/05-backups/) ([how](00-process.md#revisions)). The site lists them here, newest first, and derives the Revision and Updated rows from them.
