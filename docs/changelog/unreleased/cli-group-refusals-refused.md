---
section: Fixed / CLI
---
- A member's admin-only group commands (rename, remove, admin, rotate, link, invite, hub, picture) and an invitation already answered (`group accept`, `group decline`) answer `refused` instead of `engine`, and `group invite` into a community answers `bad_request`: a bot tells "not allowed" from the engine failing. `group rotate` by a member says "Only the admin can renew the group's secret" instead of "change the members".
