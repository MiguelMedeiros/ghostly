---
section: Fixed / CLI
---
- `file send` to a chat without a daemon now stays until the contact has the whole file, up to `--timeout` (300 s; past it, exit 4 and the file goes on with your next command). Before, it answered in under a second and left with the file unsent: the contact saw neither the file nor its message until a later command stayed online long enough. `--wait none` answers at once, and with a daemon or to a group it still answers at once by default.
