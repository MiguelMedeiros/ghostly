---
section: Fixed / CLI
---
- `ghostly settings set relays` with no usable Pkarr relay address now names the address it refused (`relays: use an https:// relay address: ftp://relay.example.org`) instead of asking for "at least one relay address" as if the list were empty. An empty list still asks for one.
