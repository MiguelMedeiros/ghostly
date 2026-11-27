---
section: Fixed / CLI
release: 1.14
---
- `ghostly file send <group> <path>` without a daemon sends the file's message to the group. It left the group's connections closed, so the members never heard of the file until the profile's next daemon ran, and the answer said nothing of it. It now waits until a member's connection took the message (`--wait sent`, its default there, up to 30 s as `group send` waits) and answers `sent` and `edges`, as `group send` does; a timeout (exit 4) names the file in `details.file`. Members fetch the file from this device, so its `note` says they get it while the profile is online (`ghostly daemon --detach`); with `--wait none` the `note` says when no member took it yet.
