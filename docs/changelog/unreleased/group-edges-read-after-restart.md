---
section: Fixed / Everywhere
---
- An app with many chats and private groups, back after a restart, looks for the group members that were online before it stopped while its chats reconnect too. Before, its chats used the requests the relays allowed it first, so a daemon with 30 chats and 5 groups reached its first group member 1 to 6 minutes after a restart, and group messages sent in its first minutes arrived 2 to 7 minutes late.
