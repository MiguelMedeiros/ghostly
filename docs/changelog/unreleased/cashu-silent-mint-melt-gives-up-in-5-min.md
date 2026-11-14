---
section: Fixed / Wallets
---
- A Lightning payment from Cashu at a mint that tries a payment again by itself (NUT-19) and never answers now stays pending after 5 minutes, instead of keeping every payment at that mint waiting for about 50 minutes. Its sats are also held for 2 more minutes after the last try, in case the mint still pays it.
