---
section: Fixed / Wallets
---
- An open USDT wallet's balance check, every 8 seconds, now asks its Ethereum RPC for the two balances only, not the chain and the token contract's whole code again each time: half the requests, and none of the contract downloads. A payment still checks the chain and the contract before it signs.
