---
section: Fixed / Wallets
---
- An open Lightning invoice nobody pays is no longer asked about every 4 seconds for its whole hour. A Cashu mint's invoice and a Lightning card's (LND, NWC, Core Lightning) are now checked every 4 seconds for their first two minutes and while the Receive screen shows them, then every 15 seconds, then once a minute: about 100 requests an hour instead of about 900. The invoice of a chat request that was closed is checked once more after it expires, so money that came all the same is still claimed. A payer's "I paid" still checks at once.
