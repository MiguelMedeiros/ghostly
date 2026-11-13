---
section: Fixed / CLI
---
- A one-shot `ghostly group send`, `group edit`, `group react` or `group typing` with no daemon running starts only the groups, not every saved 1:1 chat. With a dozen chats or unused invites saved, their relay traffic took the relays' whole minute, so the group's member connection never came up: `group send --wait sent` and `group react` timed out after 60 s, exit 4, and the text or reaction waited for the next run. Now they go out in a few seconds.
