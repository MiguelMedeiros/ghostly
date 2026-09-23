# WISP 1001 — Local File Storage

| Field | Value |
|---|---|
| Candidate number | 1001; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-23 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [1000](1000-storage.md), [05](05-backups.md) |
| Implementation | Experimental: web and desktop clients |

> This is a review draft. See the [catalogue](README.md) and the [storage contract](1000-storage.md).

## Profile

The simplest place: a file the person keeps. It needs no account, network or credential.

- `put` hands the bundle to the platform's save mechanism (a download in a browser) under the object's file name, `<created>-<random>.ghostly-backup`. The `<space>/backups/` part of the object name is dropped; the person chooses the folder.
- `get` reads a file the person picks. Any file name is accepted; the envelope decides validity.
- `list` is not available: the client cannot see the person's folders. Restores always start from a picked file.
- `remove` is not available.

## Notes

- Where the file goes after saving — a USB stick, a password manager, cloud drive sync — is outside Ghostly, and so is its protection beyond the envelope's encryption.
- On desktop the file lands in the downloads folder unless the platform asks. Native save dialogs are a planned improvement.
