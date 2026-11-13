---
section: Fixed / CLI
---
- A CLI command that names a chat (`send`, `payment list --chat`, `chat pay`, `chat forward`, file and identity commands) answers about twice as fast on a profile with many chats: it read the list of all chats two or three times to find one (`chat forward` once more per chat it forwarded to), about 40 ms per `send` at 1,000 chats and up to 1 s at 10,000. It now reads it once.
