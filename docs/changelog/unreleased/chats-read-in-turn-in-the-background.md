---
section: Fixed / Everywhere
---
- An app with many chats, back after a restart while its groups reconnect, no longer leaves some chats unread for many minutes. Its chats that are not connected yet now look for their contacts in turn, and a look the relays' limit held back goes again as soon as the limit allows. Before, the same chats took every look the limit allowed. A daemon with 30 chats and 5 groups looked for some contacts once in 10 minutes, and 5 of its 30 chats stayed down although both sides were online. Now it looks for every contact again within minutes, and 28 of the 30 chats come back.
