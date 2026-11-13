---
section: Fixed / CLI
---
- `ghostly group send --wait sent` sent by a profile that was removed from the private group while it was away, and learns it during the wait, ends at once with `refused` and the reason ("You were removed from this group: no member took it, and it no longer goes"). It waited the whole `--timeout`, then said the message stays in the group and goes when a member's connection opens, and exited with 4, though nothing goes any more. The same wait in `group edit`, `group react` and a group pin ends the same way.
