---
section: Fixed / Chat
---
- Desktop: a Pkarr relay that takes more than 10 seconds to confirm a write is no longer treated as down and skipped for minutes, which made New slow right after a start. A DHT write in the first seconds after a start, before the app knows other DHT nodes, is tried again instead of failing.
