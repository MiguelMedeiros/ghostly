---
section: Fixed / Wallets
---
- Spark and the Breez Lightning source: each profile now keeps its own Breez wallet data on the device. A profile restored as a copy on the same device used to open the original's, so the two wallets could disagree about which coins were theirs; the copy now starts from its recovery phrase with its own. The profile that was already using the shared data keeps it. Removing the wallet or deleting the profile now deletes that data too.
- Bark: a wallet restored from a Bark backup or a profile backup looks once for on-chain coins its phrase received before, so they show in the balance again. The wallet page says it is looking while it does.
