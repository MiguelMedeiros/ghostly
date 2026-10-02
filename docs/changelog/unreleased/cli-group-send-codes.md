---
section: Fixed / CLI
---
- `ghostly group send` says what a bot can do about a message that did not go: `--reply` to a message the group does not have is `not_found` (exit 3), as `group react`, `group edit` and `pin` answer; a group this profile is out of (removed, left, a forked history) is `refused`; only what may go on a later try stays `unavailable`. All of them were `unavailable` before.
