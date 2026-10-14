---
section: Fixed / Everywhere
---
- An app with many chats and private groups, back after a restart, reconnects to its group members while its chats reconnect too. Before, its chats used every request the relays allowed it, so the groups reconnected only after them. A daemon with 30 chats and 5 groups reached its group members 13 to 25 minutes after a restart, and group messages sent meanwhile did not reach it.
