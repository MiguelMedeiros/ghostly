---
section: Fixed / Wallets
---
- Redeeming ecash at a mint whose fee to take it in is the whole token (a 1-sat token at a mint that charges 1 sat per coin) is refused with a line that says so, and the token stays unspent for its sender. Before, the mint kept the coin and the wallet booked "received 0 sats".
