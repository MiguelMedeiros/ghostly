---
section: Fixed / Wallets
---
- A payment sent and still waiting for its outcome (an on-chain one in the mempool, or one sent through Ark, Bark, Spark, Fedimint or USDT) is asked about every 10 seconds only in its first minute, then less and less often, down to once every 10 minutes, as a Cashu payment already was. It was asked every 10 seconds for as long as it waited, hours for a low fee, and each time the Ark, Bark, Spark and USDT wallets were read again too. "Check existing payment" still asks at once.
