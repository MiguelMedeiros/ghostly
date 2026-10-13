---
section: Fixed / Everywhere
---
- An app with many chats, back after a restart while its contacts are online, now brings every chat back within minutes. Before, its messages to the relays used up their limit, and the few looks left went to the chats already reconnecting. Some contacts were then looked for once in 10 minutes and their chats stayed down, and those contacts showed offline after 6 minutes. Now a look the limit has held back for a minute goes before the app's next messages, the oldest first. A daemon with 30 chats and 5 groups had 21 of its 30 chats back 10 minutes after a restart, and now has all 30 back in about 5 minutes.
