---
section: Fixed / CLI
---
- `send --reply` to a message the chat does not have is `not_found` (exit 3), as `file send --reply` and `group send --reply` say. Before, it was `refused` (exit 1) with the same sentence.
