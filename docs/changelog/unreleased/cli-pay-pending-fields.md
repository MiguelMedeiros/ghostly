---
section: Fixed / CLI
release: 1.14
---
- A `pay` that the mint has not settled yet also answers `pending: true`, the invoice's `paymentHash` and the sats set aside (`setAside`). `wallet list` gives the Cashu wallet's `setAside`, as the app's card says it, and `wallet history` lists the Lightning cards' latest payments under `recent`, each by its `paymentHash`: pending until it settles, then paid or failed. Paying the same invoice again while it is pending is now `refused` (it was `engine`), naming the payment.
