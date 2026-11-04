---
section: Fixed / Wallets
---
- When a contact says they paid one of your Lightning requests, your wallet now asks the mint and your Lightning card's source about that request's invoice only. It used to ask about every open invoice of yours at once (100 open invoices meant 200 requests for one payment), which could get your wallet refused by a mint that limits how often it is asked.
