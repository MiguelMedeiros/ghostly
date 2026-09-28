---
section: For developers
---
- **A long chat's history reads one page at a time.** The engine keeps each chat's messages in time order in storage and reads only the page asked for: `messagePage` (the newest 50, or those before a message) costs the same in a chat of 2000 messages as in one of 50. `ghostly chat history` and `ghostly group history` use it, so their first page no longer reads the whole chat (about 5 ms instead of 120 to 160 ms for 2000 messages).
