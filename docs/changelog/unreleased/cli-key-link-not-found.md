---
section: Fixed / CLI
release: 1.14
---
- `app publish` and `store sign` answer a `--key` that is a symbolic link to nothing with `not_found` (exit 3), not `engine` (exit 1), also when a bundle or index already there asks for its key.
