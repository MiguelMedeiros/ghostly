---
section: Fixed / CLI
---
- `chat pay` and `chat request` from a profile with no Cashu wallet of the network now answer `refused` "You have no Testnet Cashu wallet: ghostly wallet create cashu" (`details.reason` `no_wallet`). Before, `chat pay` said "Not enough sats in your wallet" as `engine`, the code for the engine failing, and `chat request` said "No mint configured" as `unavailable`. A wallet short of sats, or of sats for the fee, now answers `refused` too.
