---
section: Fixed / Everywhere
---
- An idle chat no longer writes to the disk every time it keeps its DHT mailbox alive. Before, each keep-alive (every four minutes per chat) and each one the relays' limit held back (every 30 seconds on an app at its limit, as a daemon with 30 chats often is) rewrote the chat's saved state with a disk sync. That was 16 writes an hour per idle chat, and 242 at the limit, for nothing sent. Now it is 1 and 2.
