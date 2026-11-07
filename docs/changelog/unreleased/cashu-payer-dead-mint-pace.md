---
section: Fixed / Wallets
---
- An ecash payment in a chat that was approved while its mint could not be reached no longer asks that mint about it every 10 seconds for as long as the app is open. It is asked about every 10 seconds while the payment may still reach the mint, then less and less often, down to once every 10 minutes, and several such payments at the same mint share one try instead of each trying on its own.
