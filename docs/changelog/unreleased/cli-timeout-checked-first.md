---
section: Fixed / CLI
---
- `send`, `edit`, `group send`, `group edit` and `forward` check `--timeout` before anything goes out. A value out of range (0, 99999, an empty one) used to be refused only after the message was sent, edited or forwarded, so a retry sent it again.
