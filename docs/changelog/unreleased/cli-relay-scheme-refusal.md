---
section: Fixed / CLI
---
- `settings set irohRelays` or `hyperdhtRelay` with an address of the wrong kind (`ftp://`, or `http://` and `ws://` away from this machine) answers `bad_request` naming its key, "use an https:// relay address", instead of `engine`.
