---
section: Fixed / CLI
---
- `chat accept <chat>` with no method answers which ways of paying the chat takes now and on which networks (`methods`, `networks`), and changes nothing. Before, it was a usage error and the only way to see them was to change one. `--off` or `--networks` without a method is a usage error instead of being dropped.
