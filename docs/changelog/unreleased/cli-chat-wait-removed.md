---
section: Fixed / CLI
---
- `ghostly chat wait` on a chat that is removed while it waits now answers at once that the chat was removed (exit 3). Before, it waited out its whole `--timeout` and then said it timed out waiting for the chat to be live (exit 4).
