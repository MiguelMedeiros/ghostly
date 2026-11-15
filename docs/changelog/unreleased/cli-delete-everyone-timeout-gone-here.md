---
section: Fixed / CLI
---
- `ghostly message delete <group> <message> --everyone` whose wait for a member's edge times out (exit 4) now says the message is gone from this device and its removal goes when a member's edge opens. It said "it stays in the group", which read as if the message stayed. Its timeout, and the chat's, also carry `deleted` and, when `--purge` ran, `purged: true` in `details`, so a script that sees exit 4 knows the text already left the profile's folder.
