---
section: Fixed / Wallets
---
- A Cashu Lightning payment whose answer from the mint was lost (the connection dropped, or the app was closed while paying) now stays pending until the mint can no longer act on it. Before, it could be reported as failed and its sats shown as back in the wallet while the mint was still paying the invoice with them, and the change of that payment was lost.
