---
section: Fixed / Wallets
---
- After a Cashu mint changes its keys, an invoice already paid to you is now credited on the next check. It used to stay paid at the mint and never reach your wallet, even after a restart. A send, a redeem, a chat payment or a Lightning payment the mint turns down right after the change now fails at once with your sats back, instead of saying the mint has not answered and holding the sats for several minutes.
