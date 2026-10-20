---
section: Fixed / Wallets
---
- Send on the Lightning and Cashu cards now reads a `bitcoin:` link the way the chat does. It refuses a link that must not be paid: one with a `req-` parameter the app does not understand, or an amount it cannot read. It also leaves out a Lightning invoice that is not the same payment as its link (another amount or another network). Before, a scan or a paste of such a link went straight to the review of its invoice.
