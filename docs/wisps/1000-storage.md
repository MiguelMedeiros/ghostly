# WISP 1000: Storage Contract

| Field | Value |
|---|---|
| Candidate number | 1000; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-23 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [04](04-profiles.md), [05](05-backups.md) |
| Implementation | Experimental: local file ([1001](1001-local-storage.md)) and S3-compatible ([1002](1002-s3-storage.md)) adapters |

> This is a review draft. Candidate numbers are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md).

## Scope

Storage keeps **encrypted bundles** ([05](05-backups.md)) somewhere other than the running profile: a file the person holds, a bucket, later a WebDAV share or a relay. The 10xx family defines one contract that every place implements, so backups, and later continuity features, do not depend on any single provider. Storage never sees plaintext and never decides what a bundle contains.

## Contract

An adapter implements four operations on **objects**, which are opaque byte strings with a name:

| Operation | Meaning |
|---|---|
| `put(name, bytes)` | Stores the object. Fails rather than silently truncating. Overwriting an existing name is not required and SHOULD be avoided. |
| `get(name)` | Returns exactly the bytes stored. |
| `list()` | Returns the names this space holds, with size and modification time when the place knows them. |
| `remove(name)` | Optional. Deletes one object. |

An adapter also has a **description** for people (for example "S3 · my-bucket/ghostly") and a **test** that proves it can write, read and list before anything important is stored.

## Storage format

Two folders share a space. `<space>/backups/` holds bundles ([05](05-backups.md)); `<space>/hold/<mailbox>/` holds items sealed for an away contact ([4xx store-and-forward](4xx-store-and-forward.md)), media type `application/vnd.ghostly.held`, one random 22-character mailbox per contact. Holding needs one more operation, `presign(name, seconds)`: an address that reads one object with no credential for at most seven days; a place that cannot hand one out (a local file) cannot hold.

- Object name: `<space>/backups/<created>-<random>.ghostly-backup`, where `<created>` is a UTC timestamp `YYYYMMDDTHHMMSSZ`, `<random>` eight base32 characters, and `<space>` a random identifier chosen once per profile. Names never contain a profile name, nickname, key or device detail.
- An object is exactly one bundle envelope ([05](05-backups.md)), media type `application/vnd.ghostly.backup+json`.
- Listing a space in name order lists its backups oldest first. Restoring picks by name; the date shown comes from the name.
- Adapters that have folders or prefixes map `/` onto them; others escape it.

## Rules for every adapter

- **Encrypt before storing.** An adapter MUST only ever be given envelopes. It MUST NOT be given the passphrase or any key.
- **Credentials stay local.** Access keys, tokens and URLs belong to the profile's settings on the device. They are never inside a bundle and never sent to a contact.
- **Minimal metadata.** No tags, user metadata or content types beyond the ones above.
- **Integrity is end to end.** The envelope's authentication decides whether a restore is valid; a provider's checksum or listing is never trusted for that.
- **Honest failure.** Network, permission, quota and CORS failures are reported as such, with the place they came from.

## Family

| Number | Adapter | Status |
|---|---|---|
| [1001](1001-local-storage.md) | Local file | Experimental |
| [1002](1002-s3-storage.md) | S3-compatible object storage | Experimental |
| 10xx | WebDAV | Planned; number to be defined |
| 10xx | Nostr relays / Blossom | Planned; number to be defined |
| 10xx | Peer-held backup (a trusted contact keeps your bundle) | Planned; number to be defined |

## Open decisions

Retention (keep the last *n* per space), scheduled backups, resumable uploads for large bundles, and whether continuity beyond backups (sync between one person's devices) belongs in this family.
