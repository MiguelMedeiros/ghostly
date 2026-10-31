---
section: Fixed / CLI
---
- A `chat transport` chosen while `chat disconnect --hold` keeps a chat on the DHT now ends the hold and stays as chosen. Before, `chat transport dht` was taken back when the hold's time was up, and a chat that had gone live again still showed `heldUntil` and later said it was released.
