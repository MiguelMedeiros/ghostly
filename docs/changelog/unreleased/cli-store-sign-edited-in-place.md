---
section: Fixed / CLI
---
- `ghostly store sign` run on the `ghostly-store.json` it signed, after an edit to it, is refused as an index that does not read as a signed one, as any other edit there is. It signed it before, without comparing its sequence with the one signed there, so a lower sequence went out that every client refuses as a rollback.
