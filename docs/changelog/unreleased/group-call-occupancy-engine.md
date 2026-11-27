---
section: For developers / Calls
release: 1.14
---
- The engine's `groupCallOccupancy` asks the node a group's `call` names whether its call is on (WISP 602 § Occupancy): `count` members in it and `since` when, or a code: `not_member`, `hidden` (Hide my IP is on, so nothing is sent), `unsupported` (not asked again until the group's `call` changes), `refused`, `rate_limited` with the wait, `no_answer`, `bad_reply`.
