---
section: Fixed / CLI
---
- `chat wait <chat> --until paired` answers at once for a chat that paired before, also while the contact is offline. It waited its whole timeout and failed with `timeout` (exit 4) for a chat that was fine.
