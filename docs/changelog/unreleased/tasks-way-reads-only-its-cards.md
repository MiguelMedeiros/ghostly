---
section: Fixed / Chat
---
- The way to the Tasks board above the chat list no longer reads every chat and every member of every group each time the app's state changes, cards or not: it reads only the chats and senders of the cards it counts (with 200 chats and five communities of 256 members, 0.8 ms less work on each change, up to 20 a second while a file moves).
