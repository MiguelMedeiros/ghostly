---
section: Fixed / Wallets
---
- An open invoice of a Lightning card whose source stops answering (a node that is off, an NWC wallet whose relay is gone) is asked about less and less often (up to every 30 minutes), instead of every minute for as long as the app runs, and the source is asked about one invoice a round, not each of them. Past its expiry it shows as expired, not "waiting for payment", while it is still asked about, so a payment the source reports late still counts. Showing the invoice and a payer's "I paid" still ask at once.
