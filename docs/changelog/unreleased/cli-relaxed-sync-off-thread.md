---
section: Fixed / CLI
---
- A CLI daemon no longer stops for a second or two at a time while a big file comes in: the disk sync of its relaxed notes (delivery marks, the events it already reported), due a second after them, ran on the daemon's only thread and waited there for a busy disk, and texts, one-shot commands and the chats' upkeep waited with it. It runs off the thread now, as every other sync of the store does.
