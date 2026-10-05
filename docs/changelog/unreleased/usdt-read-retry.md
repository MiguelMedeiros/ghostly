---
section: Fixed / Wallets
---
- USDT no longer gives up on the first failed read from its Ethereum RPC. A read that fails once (a dropped request, a busy server, a block that moved on) is asked again a second later, so switching a Testnet USDT wallet to another network, restoring one, or making one with New works when the RPC hiccups once.
