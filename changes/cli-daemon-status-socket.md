---
section: Fixed / CLI
---
- `ghostly daemon status` names the daemon's socket (`socket`), as the socket examples said it did. The echo, payment and call bots now ask it when `GHOSTLY_SOCKET` is not set, instead of guessing a path that was wrong for another profile, another `GHOSTLY_HOME`, or a socket moved to `/tmp` because its path was too long.
