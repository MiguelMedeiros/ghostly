---
section: Fixed / Chat
---
- The saved messages in the sidebar no longer build a list of every chat and group each time the app's state changes, up to 20 times a second while a file moves, just to notice one coming or going: the chats and groups are checked against the ones already known, and the list is built only when one came or went (with 2,000 chats and 40 groups, about 0.1 ms less work on each change, and nothing left for the garbage collector).
