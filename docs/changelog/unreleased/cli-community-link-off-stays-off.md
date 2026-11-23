---
section: Fixed / CLI
---
- When a community's admin has turned its link off, `ghostly group link <group>` no longer turns it back on. Before, it made a new link without a word, every member's app offered Share again, and anyone handed the new link could join. Now the command is `refused` (exit 1): it says the link is off and that `ghostly group link <group> --reset` makes a new one to share. Over the socket, `group.link` with `on` left out does the same, and `on: true` or `reset: true` still turns the link on. A private group starts with no link, and `group link` still turns its link on. The help line says both.
