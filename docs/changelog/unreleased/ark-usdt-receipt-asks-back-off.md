---
section: Fixed / Wallets
---
- An open Ark request and a contact's Ark or USDT payment still waiting to be confirmed are no longer asked about at every wallet refresh (every 8 to 10 seconds) for as long as the app is open. A new request, or a transaction already on its way, is still asked about at every refresh at first, then less and less often, down to once every 30 minutes. Money that arrives late, also on an Ark request whose address expired, is still seen: at once when the balance moves, or at the next of those checks. With five unpaid Ark requests open, an hour now costs 89 reads of the Ark server instead of 1,800.
