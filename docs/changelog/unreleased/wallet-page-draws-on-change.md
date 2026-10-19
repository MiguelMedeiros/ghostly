---
section: Fixed / Wallets
---
- The Wallets page (its cards and the open wallet) is drawn again only when the wallets change. Before, it was drawn again on every change in the app, up to 20 times a second while a file moved or someone typed in a chat: with every kind of wallet open, about 6 ms of work each time, now none.
