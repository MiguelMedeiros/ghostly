---
section: Fixed / CLI
---
- An empty `--card` (an unset variable, `--card "$CARD"`) on `ghostly wallet remove`, `wallet faucet`, `wallet receive`, `pay`, `chat request` and `chat pay-request`, and an empty `card` on their socket methods, is a usage error (exit 2). Before, it counted as no card: `wallet remove cashu --card ""` removed the whole Cashu wallet, `wallet remove lightning --card ""` the network's default card, and a payment or invoice went through the default card.
