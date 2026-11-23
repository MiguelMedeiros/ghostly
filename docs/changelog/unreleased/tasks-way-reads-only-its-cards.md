---
section: Fixed / Chat
---
- The way to the Tasks board above the chat list no longer reads every chat and every member of every group each time the app's state changes, cards or not: it reads only the chats and senders of the cards it counts (in three groups of 2,000 members, 2.4-3.9 ms less work on each change, up to 20 a second while a file moves).
