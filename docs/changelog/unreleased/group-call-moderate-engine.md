---
section: For developers / Calls
---
- The engine's `groupCallModerate` lets a group's admin mute, allow, remove or unban a member in the group's call, or read who is muted and banned, through the node the group's `call` names (WISP 602 § Moderation). It answers the room's state, or a code: `not_admin` and `unsupported` before anything is sent, `refused`, `rate_limited` with the wait, `unreachable`.
