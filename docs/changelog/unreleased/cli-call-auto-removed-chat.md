---
section: Fixed / CLI
---
- Removing a chat that `call auto on --from` names now takes it off auto-answer's list, and removing the last one turns auto-answer off. Before, `call auto` still said it was on for the removed chat, so it read as on while it could answer nobody.
