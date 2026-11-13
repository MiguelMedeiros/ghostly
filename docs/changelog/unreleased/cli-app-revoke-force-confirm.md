---
section: Fixed / CLI
---
- `ghostly app revoke --up-to` past the bundle's own version now asks for `--force` with `confirm` (exit 5), as every refusal that `--force` lifts does, instead of a usage error (exit 2). A store key given to `app revoke` is refused as a key that "never signs an app or its revocations", and `app publish` names a field missing from the source as `kind in ghostly-app.json`, not as a missing `--key`.
