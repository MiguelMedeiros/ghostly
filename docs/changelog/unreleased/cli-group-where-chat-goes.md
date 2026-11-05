---
section: Fixed / CLI
---
- A command that takes only a 1:1 chat (`chat connect`, `chat pay`, `identity share`, `service share`, `call start`, `call auto --from`, the contact of `group invite` and others), given a group's name or id, now says `"Team" is a group, not a chat`, with the group's id in `details.group`, as `send` and `react` already did. It read `No chat "Team"`, as if nothing had that name. `listen --from` with a group now points to `listen --group`, and `listen --group` with a chat to `listen --from`; they pointed to `group show` and `chat show`.
