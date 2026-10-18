---
section: Fixed / Chat
---
- Saved messages are read again only when a chat or a group comes or goes. Before, a message that moved a group up the list read every saved message again, with each of its rows: with 200 saved, about 10 ms and 108 KB each time, on most group messages.
