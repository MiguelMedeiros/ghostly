---
section: Fixed / CLI
---
- `ghostly engine removeLink '{"linkId":"…"}' --yes` no longer drops a delete for everyone that has not reached the contact yet, which `chat remove` already refuses. It is refused the same way (`confirm`, exit 5) and names the messages; pass `--force` to remove the chat anyway.
