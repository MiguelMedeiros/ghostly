---
section: Fixed / Relays
---
- A HyperDHT relay full to its limits brings its browsers' chats back much faster after a restart. With every browser
  listening again at once, its DHT node spent most of its time looking through all its requests in flight and all its
  listening chats for each answer and each new listen: at the default limits fewer than half of the chats were back
  within a browser's 20 s, now three in four are, with the relay's CPU at half or less. If you run your own HyperDHT
  relay, update it from this release.
