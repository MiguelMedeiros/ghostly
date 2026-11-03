---
section: Fixed / Everywhere
---
- The Profile page costs less while it is open: it no longer draws again on every change of the app's state (up to 20 a second while a file moves) for its counts of identities, wallets and services, and it counts the chats without reading each chat's messages. With 300 chats, 20 such changes took about 150 ms of drawing in a test, now none.
