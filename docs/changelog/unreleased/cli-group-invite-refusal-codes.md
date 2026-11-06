---
section: Fixed / CLI
---
- `group invite` to a contact who is offline answers `unavailable` instead of `engine`, and an invite the group or the contact's app cannot take (already a member, a full group, an app too old for groups, for hubs or for a larger group) answers `refused`: a bot retries the first later and does not alert on the others as the engine failing.
