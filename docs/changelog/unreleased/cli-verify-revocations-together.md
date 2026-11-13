---
section: Fixed / CLI
---
- `ghostly app verify` and `ghostly app serve` of a URL read the `ghostly-revoke.json` files beside the app and beside its sources at the same time, so a host that does not answer holds the check for one wait instead of one wait per file.
