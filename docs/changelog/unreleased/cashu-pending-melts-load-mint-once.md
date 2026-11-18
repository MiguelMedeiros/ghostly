---
section: Fixed / Wallets
---
- When several Lightning payments from Cashu are still pending at a mint that stopped answering, the wallet tries to reach that mint once each time it checks, not once for every payment. With four pending payments it now sends about a quarter of the requests and keeps fewer of them open.
