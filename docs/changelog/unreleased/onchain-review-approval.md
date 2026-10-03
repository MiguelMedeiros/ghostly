---
section: Fixed / Wallets
---
- Bitcoin on-chain: a payment review that was never approved is never sent. A restored profile brings such a review back as cancelled, and a review of this kind already marked "Status unknown" now ends as failed with "This payment was never approved: nothing was sent". An approved payment that left the mempool is still sent again on its own, as before.
