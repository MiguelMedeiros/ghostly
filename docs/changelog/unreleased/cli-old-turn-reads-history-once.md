---
section: Fixed / CLI
---
- An agent answering a turn older than the chat's newest 200 messages (a busy group, or a catch-up with `listen --cursor`) reads the whole history once for it, not again for each reply, reaction or pin that names it. A turn whose message was deleted for everyone before the answer is also looked up once. Each such command read the whole history and hashed every message, about 75 ms of hashing plus ~0.5 s of reading per 50,000 messages.
