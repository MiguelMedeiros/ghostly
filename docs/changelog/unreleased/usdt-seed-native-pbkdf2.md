---
section: Fixed / Wallets
---
- The app stays responsive as it starts with a USDT wallet that opens by itself (every new profile has one): the wallet makes its key's seed with the browser's own PBKDF2, no longer in script on the page's thread (the longest freeze in opening it, 15 ms down to 6.5 ms; on a phone-speed CPU about 80 ms less).
