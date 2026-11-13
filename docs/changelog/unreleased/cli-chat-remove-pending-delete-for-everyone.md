---
section: Fixed / CLI
---
- `ghostly chat remove <chat> --yes` no longer drops a delete for everyone that has not reached the contact yet. Before, the chat went and the removal went with it, so the contact kept the message for good, though `message delete --everyone` had said its removal would still go. It is now refused (`confirm`, exit 5) and names the messages. Keep the profile online until the contact is reachable, or pass `--force` to remove the chat anyway.
