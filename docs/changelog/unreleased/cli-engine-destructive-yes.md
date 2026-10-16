---
section: Fixed / CLI
---
- `ghostly engine` calls that delete chats or groups (`clearProfileData`, `removeLink`, `leaveGroup`, `forgetGroup`, `deviceRemove`) ask for `--yes` (`confirm`, exit 5, without it), as `chat remove` and `group leave` do. `clearProfileData` answers how many chats and groups it removed instead of `null`, and a daemon stops after it: it kept listing the deleted chats and groups, and taking commands it did not keep, until it was stopped.
