---
section: Fixed / CLI
---
- `ghostly app revoke` with the same `--digest` values in another order no longer adds a second revocation to `ghostly-revoke.json`: the digests are signed sorted, and the second run answers `added: false`.
