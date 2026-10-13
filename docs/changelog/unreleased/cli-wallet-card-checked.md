---
section: Fixed / CLI
---
- `wallet remove`, `wallet faucet` and `wallet receive` check the Lightning card `--card` names before anything happens: with a type of wallet other than `lightning` it is a usage error (exit 2), and a card that is not on the network is `not_found` (exit 3), as `lightning default` says. Before, `wallet remove cashu --card <a typo>` removed the whole Cashu wallet and answered that the card was removed.
