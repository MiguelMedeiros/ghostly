---
section: Fixed / Wallets
---
- An open Ark wallet asks its explorer and its Ark server less often. Its refresh every 10 seconds read the balance twice, once for what is spendable and once for what waits on-chain, and each read asked both. It now reads once: for one wallet, 7 explorer requests a minute instead of 13, and 19 Ark server requests instead of 25.
