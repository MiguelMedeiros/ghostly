---
section: Fixed / Wallets
---
- A Lightning card (or a Bitcoin wallet's server) that stops answering is no longer asked for its balance every 15 seconds for good (240 failed requests an hour): each failed read waits twice as long as the last, up to 30 minutes, while the card keeps saying the balance could not be read. Retry, coming back to the app and a read that answers go back to every 15 seconds.
