---
section: Fixed / Wallets
---
- A Cashu payment approved while its mint could not be reached no longer stays "unknown" with its sats locked. Once the mint is back and says nothing was spent and nothing was signed, the payment is marked failed, the sats come back to the wallet, and the request can be paid again.
