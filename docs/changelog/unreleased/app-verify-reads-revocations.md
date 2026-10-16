---
section: Fixed / CLI
---
- `ghostly app verify` and `ghostly app serve` refuse a version its publisher revoked in the `ghostly-revoke.json` beside the bundle (beside the file, or beside the URL as a client reads it), with the reason `revoked` and the publisher's words. Before, they took it as valid, though a client stops it.
