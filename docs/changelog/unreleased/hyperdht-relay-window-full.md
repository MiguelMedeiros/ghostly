---
section: Fixed / Relays
---
- A HyperDHT relay holding as many browsers' chats as its limits allow keeps every chat reachable. Its DHT node could
  send only a sixth of the keep-alives those chats need at once, so they piled up (over 40,000 waiting at the default
  limits), timed out, and the chats' announcements lapsed. If you run your own HyperDHT relay, update it from this
  release.
