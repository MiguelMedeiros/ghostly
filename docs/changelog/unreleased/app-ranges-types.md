---
section: For developers
---
- `@ghostlytools/sdk/app` types the read lane an app will use to let the same app on the contact's side read a file the person picked: `ghostly.files.serve` and `files.unserve`, and on the other side `ghostly.remote.read` and `remote.stat`, with the new refusal code `not-served` and the limit `remoteReadBytes` (1 MiB). Ghostly does not answer them yet.
