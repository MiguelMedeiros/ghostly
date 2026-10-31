---
section: Fixed / CLI
---
- `ghostly typing --kind` and `group typing --kind` take only typing, recording or thinking, and `send --button` refuses a
  `--style` other than primary, neutral or danger and an id given to two buttons. A typo there is now a usage error that
  names the flag (exit 2) before the profile opens. Before, it came back from the API as a `bad_request` (exit 1).
