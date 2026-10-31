---
section: Fixed / CLI
---
- `chat connect` on a chat your contact keeps on DHT only is refused and says so (`details.reason: "peer-dht-only"`; your own DHT only is `dht-only`). Before, it failed as an engine error asking both sides to choose a live method, though yours already had.
