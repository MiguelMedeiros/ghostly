---
section: Fixed / CLI
---
- `ghostly group send --wait sent` in a private group with nobody else in it (they all left, or nobody accepted the invitation yet) answers at once, with `sent: false` and a note that nobody gets the message, not even someone who joins later. It waited the whole `--timeout`, said the message would go once a member's connection opened, and exited with 4. A bot that retried on that sent the message again each time. The same wait in `group edit`, `group react`, a group pin, `message delete --everyone`, `button update`, `button press`, cards and forwards answers at once too, with the same note.
