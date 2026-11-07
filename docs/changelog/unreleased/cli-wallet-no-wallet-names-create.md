---
section: Fixed / CLI
---
- `wallet faucet`, `wallet receive` and `wallet address` on a profile with no wallet of that type and network now say so and name the command that makes one, `You have no Testnet Cashu wallet: ghostly wallet create cashu` (`… create bitcoin`, `… create arkade`), as `chat pay` does: `refused` with `details.reason: "no_wallet"`. Before, they answered `unavailable` (try again later) "This wallet has no test mint" or "No mint configured", which a bot retries. A wallet that exists and whose mint or source does not answer is still `unavailable`; the exit code stays 1.
