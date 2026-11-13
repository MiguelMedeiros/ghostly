---
section: Fixed / CLI
---
- `ghostly settings set` refuses a key it does not change, or a value of the wrong kind (`online maybe`), as a usage error (exit 2) before the profile opens: an unknown key names the nearest one (`sendtyping`: did you mean `sendTyping`?) and lists them. Before, the profile opened and asked the relays first, then answered `bad_request` (exit 1) with no hint.
