---
section: Fixed / CLI
---
- When every Pkarr relay answers 429 (too many requests from your address), a daemon reads its contacts on the DHT instead, at the share the relays would have given it, as it already did when the relays were down. Before, it read none of them until a relay took requests again: in a test with 10 minutes of 429s, none of 50 contacts was read.
