---
section: Fixed / CLI
---
- Reading a whole chat from `rows.db` no longer copies every message a second time after reading it from disk: a chat of 10,000 messages reads in 135 ms instead of 194 ms (50,000: 669 ms instead of 894 ms), close to what the store in memory took. Each message a daemon sends reads its chat, so sends in long chats get faster too.
