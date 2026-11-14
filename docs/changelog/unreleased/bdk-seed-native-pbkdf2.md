---
section: Fixed / Wallets
---
- The app stays responsive as it opens a saved BDK on-chain wallet (at every start and every reconnect): the wallet makes its seed with the browser's own PBKDF2, no longer in script on the page's thread (about 35 ms less of a held thread on a desktop CPU).
