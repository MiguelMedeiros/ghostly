---
section: Fixed / Relays
---
- A HyperDHT relay set to 1 to 3 handshakes at a time (`GHOSTLY_RELAY_HANDSHAKES`) lets a client that hands it its key take incoming connections again, as Ghostly's own browsers already could: with 1, it refused every one of them. Its log line for that limit names the count it really keeps.
