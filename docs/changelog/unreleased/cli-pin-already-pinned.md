---
section: Fixed / CLI
---
- `ghostly pin` and the socket's `chat.pin` on the message that is already pinned change nothing and send nothing (a group's answer says `"sent": false`). Before, the pin passed to whoever ran it, so in a private group it went away when that member left or was removed.
