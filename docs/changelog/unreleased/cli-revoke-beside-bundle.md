---
section: Fixed / CLI
---
- `ghostly app revoke --bundle <file>` adds the revocation to the `ghostly-revoke.json` beside that bundle, where `app verify`, `app serve` and the app read it, and `app publish --out <file>` refuses a version the list beside `--out` already revokes. Before, the revocation always went into the app's folder: for a bundle published elsewhere nothing read it, and `app verify` still called the revoked version valid while `app revoke` said `current: true`.
