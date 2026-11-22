---
section: Fixed / CLI
release: 1.14
---
- `group hub` on a community is now `refused` ("… is a community: it chooses its hubs by itself"), checked before the engine, as `group call` checks a private group. It answered `engine`, which reads as a fault worth a retry.
- A link join not let in yet: `group show` and `group list` give `invitation.chat: null`. It was the engine's id for the knock, which `chat show` does not know.
