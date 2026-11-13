---
section: Fixed / Everywhere
---
- The web app, Desktop, Android and the browser extension load about 14 KB less (gzip) when they open. Nostr's library used its own older copies of the crypto code the app already carries, so a second copy of the same curve and hash code shipped in the first load.
