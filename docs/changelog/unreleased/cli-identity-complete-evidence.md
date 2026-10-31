---
section: Fixed / CLI
---
- `identity complete <draft>` reads the tool's output piped to it (`ssh-keygen … | ghostly identity complete <draft>`), as `send` and `invite join` do, and a proof that needs one, given none, is a usage error naming `--evidence-file` and stdin. Before, it ignored the pipe and said "evidence is required". A published record still needs nothing.
