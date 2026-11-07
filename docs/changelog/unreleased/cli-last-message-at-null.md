---
section: Fixed / CLI
release: 1.11
---
- `chat list`, `chat show`, `group list` and `group show` (and the socket's `chat.list`, `chat.get`, `group.list`, `group.get`, and the `summary` of the `chat.created` and `group.created` events) say `lastMessageAt: null` for a chat or a group with no message yet, as they say null for every other time not reached yet. Before, they said `0`, which a bot read as 1 January 1970. A script that compares the field should read null as "no message yet"; the lists still put those chats and groups after the ones with messages.
