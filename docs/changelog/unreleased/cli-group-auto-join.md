---
section: For developers / CLI
release: 1.11
---
- `ghostly group auto on --from <chat>` lets a bot join its owner's groups by itself: the daemon accepts an invitation that comes over one of the chats named at once, and on start the ones that came while it was down. Name every chat in one command (`--from alice --from bob`): a new `group auto on` replaces the list, as `call auto on` does. Any other invitation still waits for `group accept`. There is no "from anyone", and a chat whose contact's key changed loses it. `group auto` prints the setting, `group list` shows it.
