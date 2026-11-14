---
section: Fixed / Chat
---
- A contact that looks online but can't be reached no longer slows the whole app while it sits idle: each failed try to reach them (every 20 seconds to 3 minutes) now rebuilds only that chat, not every chat and group. With 2,000 chats that is about 0.65 ms instead of 20 ms per try (0.09 ms instead of 1.6 ms with 200).
