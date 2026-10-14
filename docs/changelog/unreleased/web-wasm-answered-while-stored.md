---
section: Fixed / Wallets
---
- Web app: the first time a wallet (or the Iroh connection) loads after an update, its code is compiled while it downloads again. The service worker used to hand the file to the page only once all of it (2 to 12 MiB) was saved for offline use, so the compile started after the last byte. Slow phones gain the most.
