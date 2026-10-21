---
section: Fixed / Wallets
---
- A payment to a Testnet on-chain (BDK) request made after more than 20 unpaid requests is now found when the wallet is restored from its recovery phrase. Once 19 handed-out addresses are waiting unpaid, the wallet gives out one of them again (the one shown longest ago, and only after an hour) instead of a new address. Before, the restore stopped looking after 20 unused addresses in a row, and every address ever handed out was checked again at every sync.
