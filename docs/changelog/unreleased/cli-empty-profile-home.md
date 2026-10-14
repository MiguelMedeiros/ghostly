---
section: Fixed / CLI
---
- An empty `--profile` (a script's `ghostly -p "$BOT" …` with `BOT` unset, or `--profile=`) ran the command as the current profile, so a script meant for its bot could send, make invites and change settings as the person's own profile. An empty `--home` (or `GHOSTLY_HOME`) used the current folder and made a new profile there. Both options are now a usage error when empty, and an empty variable counts as unset.
