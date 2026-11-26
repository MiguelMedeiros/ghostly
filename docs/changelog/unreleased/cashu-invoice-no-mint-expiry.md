---
section: Fixed / Wallets
---
- A Cashu Lightning invoice from a mint that gives no expiry for it is let go once the invoice itself expired. Before, its mint was asked about it every minute for as long as the app ran, and the invoice was kept across restarts.
