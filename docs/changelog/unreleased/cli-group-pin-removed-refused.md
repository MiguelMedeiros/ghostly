---
section: Fixed / CLI
---
- `pin` in a group you were removed from now fails with `refused` and the group's reason ("You were removed from this group"), as `group send` and `group react` do. Before, it failed as `bad_request` with "You are not in this group".
