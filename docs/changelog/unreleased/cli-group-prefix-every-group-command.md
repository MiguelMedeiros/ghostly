---
section: Fixed / CLI
---
- `group:<id>` (or `group:` with a prefix or a name), which the docs give as the way a script names a group, now names that group on every `group …` command (`group show`, `group send`, `group history`, `group invite`, …) and in `listen --group`, as it already did on the commands that take a chat or a group (`task send`, `file send`, `pin`). Before, those answered `not_found` "No group" (exit 3), and `listen --group group:<id>` did not start. A `group:` ref never names a chat.
