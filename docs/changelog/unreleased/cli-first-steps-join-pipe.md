---
section: Fixed / CLI
---
- The first steps `ghostly` shows in a new Ghostly folder join an invite as `printf '%s' "$INVITE" | ghostly invite join`. They showed `ghostly invite join -`, which typed at a terminal answers a usage error (an invite is not read from a terminal, to keep it off the screen and out of the history).
