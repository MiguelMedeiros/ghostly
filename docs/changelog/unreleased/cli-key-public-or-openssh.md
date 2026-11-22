---
section: Fixed / CLI
---
- `app publish`, `app revoke` and `store sign` name a public key given as `--key` (an SSH `.pub` file) as a public key, instead of asking for a `chmod 600` and then saying it holds no usable key, and name an OpenSSH key file (as ssh-keygen writes) as one, with what to do instead.
