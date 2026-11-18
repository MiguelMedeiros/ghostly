---
section: Fixed / Wallets
---
- The app downloads and runs about 46 KB less when it opens (14 KB gzip, 11 KB brotli on the web): the code that talks to an LND or Core Lightning node, a browser wallet (WebLN), a BDK wallet or Breez now loads when a card of that kind connects, as Nostr Wallet Connect and Bitcoin Core already did. The test-only fake wallets are no longer in a release build at all. Desktop and the browser extension load the same smaller start.
