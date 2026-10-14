---
section: Fixed / Everywhere
---
- CLI: the profile's name has one rule whichever command sets it (`profile create --name`, `profile set --name`, `settings set nick`): up to 64 characters on one line, trimmed. `settings set nick` used to take any length, and every one of them took a line break or a tab. Before, `status` and `profile show` printed such a name whole, though contacts only ever saw its first 64 characters.
