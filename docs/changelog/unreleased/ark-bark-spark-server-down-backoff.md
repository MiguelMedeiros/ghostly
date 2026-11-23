---
section: Fixed / Wallets
---
- An Ark, Bark or Spark wallet whose server stops answering (down, or you are offline) now asks it less and less often, up to every 5 minutes, and again at once when the app comes back to the front or online. It asked every 10 seconds for as long as the app ran, 360 times an hour with several failed requests each, and a wallet that could not connect tried again every 30 seconds.
