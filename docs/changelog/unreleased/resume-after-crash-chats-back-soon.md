---
section: Fixed / Everywhere
---
- After the app or a CLI daemon is killed (a crash, an out-of-memory kill, a power cut) and started again, chats whose contacts are online are live again within seconds of the contacts noticing, not after a minute: the looks for their answers no longer spend the relays' request budget before the answers come. A test with 14 chats had all 14 back within 30 s, where none were back within the first minute before.
