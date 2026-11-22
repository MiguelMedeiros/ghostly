---
section: Fixed / CLI
---
- `app publish` and `store sign` with a `--key` that is a symbolic link to nothing (a key on a drive that is not mounted) say so, with where the link leads and that no key was made, instead of "EEXIST: file already exists".
