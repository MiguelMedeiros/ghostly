---
section: Fixed / CLI
---
- `chat history --after` and `group history --after` now read only the page they answer. Before, each call read the chat's whole history and cut it: in a chat of 7,000 messages a bot asking what came since its last message cost the daemon 94 ms a call, now 7 ms, as a plain page does.
