---
section: Fixed / CLI
---
- After a device's clock ran ahead and was set right, a restarted CLI's publishes to the DHT are no longer all refused until the clock catches up: each goes out once more, dated past the packet the DHT holds, and a failed publish now says the DHT refused it, not only the relays.
