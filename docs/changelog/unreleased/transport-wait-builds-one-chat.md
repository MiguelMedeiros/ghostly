---
section: Fixed / Chat
---
- A chat set to one connection method (Iroh with fallback off, say) whose contact can't be reached that way no longer slows the whole app: each failed try now rebuilds only that chat, not every chat and group. With 2,000 chats that is about 0.7 ms instead of 33 ms per try (0.09 ms instead of 2 ms with 200).
