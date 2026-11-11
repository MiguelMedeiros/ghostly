---
section: Fixed / CLI
---
- `chat connect` started before this side learns that your contact put the chat on DHT only (it reads that from the DHT, up to 30 s later) is refused as `peer-dht-only` when it learns it, as one started after. Before, it ended as an engine error, "Both peers must choose a live method first", which read as if the engine had failed.
