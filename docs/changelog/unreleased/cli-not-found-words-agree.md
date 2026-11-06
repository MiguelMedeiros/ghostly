---
section: Fixed / CLI
---
- A ref that names nothing is worded the same way on a profile, a chat and a group. `ghostly profile use <name>` and `--profile <name>` on a profile that does not exist both say `No profile "<name>" (ghostly profile list, or ghostly profile create <name>)`; before, `profile use` said only "No profile <name>". `saved add` and `saved remove` with a message id a group lacks say "group", as `pin` and `message details` do, not "That message is not in this chat". A `group:` ref is echoed as given (`"group:"`, `"group:k86q"`), not as the part after the prefix. The codes and exit codes are unchanged.
