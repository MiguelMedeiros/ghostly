---
section: Fixed / CLI
---
- `group edit` and `message delete <group> <message> --everyone` in a group you were removed from now fail with the group's reason ("You were removed from this group"), as `group send`, `group react` and `pin` do. Before, they said "You are not in this group".
