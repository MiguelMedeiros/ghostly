---
section: Fixed / CLI
release: 1.14
---
- `app publish`, `app revoke` and `store sign` refuse a public key given as `--key` with `bad_request` whatever its file mode, no longer `refused` when others may read it: a public key is no secret.
