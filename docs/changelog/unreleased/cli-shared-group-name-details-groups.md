---
section: Fixed / CLI
release: 1.14
---
- A command that takes only a 1:1 chat, given a name two or more groups share, now gives their ids in `details.groups` of its `not_found` answer (exit 3), as a name one group has gives its id in `details.group`, so a script can pick the group and run the group command with its id.
