---
section: Fixed / CLI
---
- A CLI daemon with many chats no longer puts the same records on the DHT again every few seconds while the relays' request budget is spent: a publish the DHT took is out, and the relays get it once their budget frees.
