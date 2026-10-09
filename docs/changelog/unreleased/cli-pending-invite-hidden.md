---
section: Security
---
- CLI: `chat list`, `chat show` and the other commands that print a chat no longer print a pending chat's invite code; it shows as `<hidden>` unless you add `--show-secret` to `chat list` or `chat show`. `engine getState` hides it too. `invite create` prints it as before.
