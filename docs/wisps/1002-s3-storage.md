# WISP 1002: S3-Compatible Storage

| Field | Value |
|---|---|
| Candidate number | 1002; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-23 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [1000](1000-storage.md), [05](05-backups.md) |
| Implementation | Experimental: web and desktop clients; exercised against a local S3-compatible server |

> This is a review draft. See the [catalogue](README.md) and the [storage contract](1000-storage.md).

## Profile

Any service speaking the S3 object API: AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO, Garage and others.

**Configuration** (kept in the profile's local settings, never in a bundle): endpoint URL (HTTPS, or HTTP to `localhost`/`127.0.0.1` for testing), region (default `us-east-1`), bucket, optional key prefix, access key id and secret access key, and path-style or virtual-hosted addressing (path-style by default, which every compatible service accepts).

**Operations**

| Contract | Request |
|---|---|
| `put` | `PUT /<bucket>/<prefix><name>` with the envelope as body, `Content-Type: application/vnd.ghostly.backup+json` |
| `get` | `GET /<bucket>/<prefix><name>` |
| `list` | `GET /<bucket>?list-type=2&prefix=<prefix><space>/backups/`, following `continuation-token` |
| `remove` | `DELETE /<bucket>/<prefix><name>` |
| `presign` | `GET /<bucket>/<prefix><name>?X-Amz-Algorithm=…&X-Amz-Credential=…&X-Amz-Date=…&X-Amz-Expires=…&X-Amz-SignedHeaders=host&X-Amz-Signature=…`, signed in the client, `UNSIGNED-PAYLOAD`, at most seven days ([4xx](4xx-store-and-forward.md)) |

Every request is signed with AWS Signature Version 4 in the client (`x-amz-content-sha256` carries the payload hash; `UNSIGNED-PAYLOAD` is not used). No SDK, proxy or server of Ghostly's sits in between.

**Test**: put a small probe object, read it back, list it, and remove it.

## Requirements on the bucket

- A browser or WebView client needs the bucket's **CORS** rules to allow the app's origin, the methods above and the headers `authorization`, `content-type`, `x-amz-date`, `x-amz-content-sha256`. Desktop and web origins differ; the client reports a CORS failure as such.
- The key needs only `PutObject`, `GetObject`, `ListBucket` (limited to the prefix) and optionally `DeleteObject`. A dedicated key per profile is recommended.
- Server-side encryption and versioning are allowed and add to, never replace, the envelope's encryption.

## Security notes

- The secret access key is stored on the device, in the profile's settings, like any other profile data. Someone who can read the profile can use the key; scope it accordingly.
- The provider sees object sizes, timing and the client's IP address, not content.
- A contact picking up held items reads presigned addresses from its own client, so the bucket's CORS rules must allow `GET` from that client's origin; `*` for `GET` is fine (the address is the authorization, and the object is ciphertext). Writes stay the person's own.
- Names never leave the app's folders: a client MUST refuse object names other than `<space>/backups/<file>` and `<space>/hold/<mailbox>/<file>` (no empty, `.` or `..` segments, in the prefix either), MUST ignore listed keys outside the folder it asked for, and SHOULD bound listing pages (this client: 100) and object size (the bundle limit of [05](05-backups.md)). Someone else with write access to the bucket, or the provider, can then at most offer a bundle that fails to open.
