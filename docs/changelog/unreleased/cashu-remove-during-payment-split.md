---
section: Fixed / Wallets
---
- Removing a Cashu wallet while a Lightning payment from it is still splitting its ecash waits for that step, and is refused once the payment is at the mint, as for any payment in flight. Before, the removal went through, deleted the payment's reserved ecash, and when the payment failed the history booked the whole amount as a fee.
