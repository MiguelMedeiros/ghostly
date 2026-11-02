---
section: Fixed / CLI
---
- `ghostly service share <service> <chat>` now finds the chat only by its id, its contact's key or a label you gave it, as `call auto --from` and `listen --from` already do. A contact's own name or a prefix of the chat's id is refused with the chat it found. Before, `service share notes alice` gave the app to whichever contact called itself "alice" when no chat had that label.
