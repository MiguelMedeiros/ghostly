---
section: Fixed / Groups
---
- `ghostly group history` gives a group's own lines ("Group created…", "You joined…", "You renamed the group to …") `"from":"system"`, not `"peer"`, so a bot that reads others' words by `from` no longer takes them for a member's message.
