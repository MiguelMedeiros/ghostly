---
section: Fixed / CLI
---
- `ghostly app verify` and `ghostly app serve` of a URL also read the publisher's `ghostly-revoke.json` beside each of the app's sources, as the app does, so a version its publisher revoked there is refused instead of verifying valid.
