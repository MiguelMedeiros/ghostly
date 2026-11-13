---
section: Fixed / CLI
---
- `ghostly file send <group> <path>` without a daemon sends the file's message to the group. It left the group's connections closed, so the members never heard of the file until the profile's next daemon ran, and the answer said nothing of it. It now waits until a member's connection took the message (`--wait sent`, its default there) and answers `sent` and `edges`, as `group send` does; with `--wait none` a `note` says when no member took it yet.
