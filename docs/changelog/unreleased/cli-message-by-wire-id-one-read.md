---
section: Fixed / CLI
---
- `ghostly react`, `pin`, `edit`, `message delete` and `message retry` naming a message by its wire id are faster on a long chat when no daemon runs: the command read the chat's whole history once more before it went online, about 0.2 s more at 50,000 messages and 0.45 s at 100,000.
