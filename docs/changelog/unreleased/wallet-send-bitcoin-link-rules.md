---
section: Fixed / Wallets
---
- Send in the Cashu and Lightning wallets reads a `bitcoin:` link the way the chat does: its Lightning invoice is paid only when it is the same payment as the link (same amount, same network), and a link that asks for something this app does not understand, or names an amount it cannot read, is refused instead of being paid by its invoice.
