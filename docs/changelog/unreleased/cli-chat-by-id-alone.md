---
section: Fixed / CLI
---
- A CLI command that names a chat by its id (as a bot does, from the `chat` of an event) builds only that chat, not the list of every chat: a `send` from a `listen --exec` bot spent 20-40 ms of the daemon's time on it at 1,000 chats, and up to 1 s at 10,000.
