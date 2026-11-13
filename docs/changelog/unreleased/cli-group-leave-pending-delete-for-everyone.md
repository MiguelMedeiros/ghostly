---
section: Fixed / CLI
---
- `ghostly group leave <group> --yes` and `group forget <group> --yes` no longer drop a delete for everyone not said to the group yet. Before, the group's record went and the removal with it, so the members kept the message for good. They are now refused (`confirm`, exit 5) and name the messages, as `chat remove` is, and so are `ghostly engine leaveGroup` and `engine forgetGroup`. Keep the profile online until a member is reachable, or pass `--force` to go on anyway.
