---
section: Fixed / Wallets
---
- A USDT wallet whose Ethereum server stops answering (down, busy, or you are offline) now asks it less and less often, up to every 5 minutes, and again at once when the app comes back to the front or online. It asked every 8 seconds for as long as the app ran, about 1,500 failed requests an hour, and a wallet that could not connect tried again every 30 seconds.
