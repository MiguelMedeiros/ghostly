---
section: Fixed / CLI
---
- `ghostly react`, `pin`, `edit`, `message delete` and `message retry` with a message id the chat doesn't have now answer `not_found` at once when no daemon runs. The command first went online in that chat and waited for the relays before it said "No message", 4 to 10 s with relays that are slow or don't answer.
