---
section: Fixed / Wallets
---
- A payment request in a chat whose Lightning invoice (or Ark, Bark, Spark, USDT or on-chain address) has expired now reads "Expired" on both sides: the person who asked is told to ask again with a new request, and the person asked is told to ask for a new one. Review payment and Pay with another wallet are gone from it, so the dead invoice is no longer handed to another wallet. A request that a mint you both use can still pay in ecash stays open. Before, both sides kept showing "Waiting for payment", and paying it ended in "That invoice has expired".
