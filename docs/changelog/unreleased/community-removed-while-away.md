---
section: Fixed / Groups
---
- A member removed from a community while their app was closed is told when they come back: the group says they were removed and the composer closes. Before, the group looked alive and their messages went nowhere.
- Opening a community's link again lets a removed member back in, with their history kept. Before, they had to delete the group first.
- CLI: `group send` answers `sent: true` only once an edge took the message, and `group send` and `group react` are `refused` for a profile that is no longer a member.
- In a community, hubs exchange the group's messages only with current members.
