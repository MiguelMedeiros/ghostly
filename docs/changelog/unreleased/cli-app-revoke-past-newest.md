---
section: Fixed / Everywhere
---
- CLI: `ghostly app revoke --up-to N` with N past the bundle's own sequence (a typo, 30 for 3) is now a usage error naming the newest version, unless `--force`. `ghostly app publish` refuses a sequence that the folder's `ghostly-revoke.json` already revokes (`details.reason` `revoked`) and names the `--sequence` that clears it. Before, both went through without a word, and clients that read the revocation stopped the new version for good.
