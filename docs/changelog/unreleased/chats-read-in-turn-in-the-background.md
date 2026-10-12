---
section: Fixed / Everywhere
---
- An app with many chats, back after a restart while its groups reconnect, now brings back every chat whose contact is online. Its chats that were not connected yet read their contacts in turn, and a chat the relays' limit held back reads again as soon as the limit allows. Before, the same chats took every read the limit allowed: a daemon with 30 chats and 5 groups read some contacts once in 10 minutes, and a quarter of its chats stayed down although both sides were online.
