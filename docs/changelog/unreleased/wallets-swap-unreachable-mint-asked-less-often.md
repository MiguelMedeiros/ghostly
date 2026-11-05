---
section: Fixed / Wallets
---
- A wallet no longer asks forever at the same pace about something that does not answer. A Cashu send or redeem left open at a mint that stops answering, ecash from a restored backup at a mint that cannot say whether it is spent, and a Lightning card payment its source keeps pending or cannot be reached about are asked about less and less often (up to every 10 or 30 minutes), instead of every 15 to 60 seconds for as long as the app runs. An app restart asks at once, and so do the wallet's refresh and removing the wallet.
