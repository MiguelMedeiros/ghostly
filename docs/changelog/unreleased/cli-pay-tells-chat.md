---
section: Fixed / CLI
---
- `ghostly pay <invoice> --chat <chat>` tells that chat's contact a Testnet invoice was paid, as a chat card's Pay
  does. A test mint marks every invoice paid by itself, so an invoice from `wallet receive` counts only on its payer's
  word. Before, a bot could pay a contact's Testnet invoice but had no way to give that word: its test sats left and
  the invoice was never received.
