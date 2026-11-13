---
section: Fixed / Wallets
---
- An open Bark or Spark request is no longer asked about at every wallet refresh (every 10 seconds) for as long as the app is open, each time with a sync to the Bark server or to Spark. A new request is still asked about at every refresh at first, then less and less often, down to once every 30 minutes. Money that arrives late, also on a request whose invoice expired, is still seen: at once when the balance moves, or at the next of those checks. With five unpaid requests open, an hour now costs 25 syncs instead of 360.
